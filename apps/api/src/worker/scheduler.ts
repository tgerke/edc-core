import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { usersWithPermission } from "../auth/rbac.js";
import type { Db } from "../db/client.js";
import {
  formInstances,
  notifications,
  studyEventInstances,
  subjects,
  users,
} from "../db/schema/index.js";
import {
  createEmailTransport,
  type EmailConfig,
  type EmailTransport,
  loadEmailConfig,
} from "../services/email.js";
import { notify } from "../services/notifications.js";
import { loadAnomalyConfig, scanSecurityAnomalies } from "../services/security-anomalies.js";

/**
 * The in-process scheduler: one setInterval in the API driving three
 * idempotent jobs — the overdue-form scan, the security-anomaly sweep, and
 * the email outbox. Assumption (matching
 * infra/compose.yaml): a single API instance. A second instance is harmless
 * anyway — each tick takes a pg_try_advisory_lock and skips if another
 * holder is mid-tick, and both jobs are idempotent (dedupe key / outbox
 * columns) — it would just be wasted work.
 */

export interface SchedulerConfig {
  /** Minutes between ticks; 0 disables the scheduler entirely. */
  scanMinutes: number;
  /** Days after event creation before an unfinished form counts as overdue;
   * 0 disables the overdue scan. A crude signal by design: visit windows
   * are protocol modeling, not notifications — this is env-tunable and off
   * by default so nobody gets nonsense reminders. */
  overdueDays: number;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

export function loadSchedulerConfig(): SchedulerConfig {
  return {
    scanMinutes: envNonNegativeInt("EDC_NOTIFY_SCAN_MINUTES", 15),
    overdueDays: envNonNegativeInt("EDC_FORM_OVERDUE_DAYS", 0),
  };
}

/**
 * Notifies site data-entry holders about forms still not_started/in_progress
 * `overdueDays` after their event instance was created. The dedupe key
 * (formInstanceId) makes every re-scan a no-op for already-notified pairs —
 * one overdue notification per form per user, ever. The scheduler scans every
 * study; `scope` exists so tests against a shared database can confine the
 * scan to their own fixtures.
 */
export async function scanOverdueForms(
  db: Db,
  overdueDays: number,
  scope?: { studyId: string },
): Promise<number> {
  if (overdueDays <= 0) return 0;
  const cutoff = new Date(Date.now() - overdueDays * 86_400_000);
  const rows = await db
    .select({
      formInstanceId: formInstances.id,
      formOid: formInstances.formOid,
      subjectKey: subjects.subjectKey,
      studyId: subjects.studyId,
      siteId: subjects.siteId,
    })
    .from(formInstances)
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .innerJoin(subjects, eq(studyEventInstances.subjectId, subjects.id))
    .where(
      and(
        inArray(formInstances.status, ["not_started", "in_progress"]),
        lt(studyEventInstances.createdAt, cutoff),
        ...(scope ? [eq(subjects.studyId, scope.studyId)] : []),
      ),
    );

  let created = 0;
  for (const row of rows) {
    const recipients = await usersWithPermission(db, "data.enter", {
      studyId: row.studyId,
      siteId: row.siteId,
    });
    await notify(
      db,
      recipients.map((userId) => ({
        userId,
        studyId: row.studyId,
        type: "form.overdue" as const,
        title: `Form overdue: ${row.subjectKey}`,
        body: `${row.formOid} not completed after ${overdueDays} day${overdueDays === 1 ? "" : "s"}`,
        payload: {
          formInstanceId: row.formInstanceId,
          subjectKey: row.subjectKey,
          formOid: row.formOid,
        },
        dedupeKey: row.formInstanceId,
      })),
    );
    created += recipients.length;
  }
  return created;
}

const MAX_EMAIL_ATTEMPTS = 3;

/**
 * The email outbox: sends unsent notifications to users with an email
 * address, one plain-text mail each. Success stamps emailed_at; failure
 * bumps email_attempts (retried on later ticks, capped).
 */
export async function dispatchEmails(
  db: Db,
  transport: EmailTransport,
  config: Pick<EmailConfig, "from" | "baseUrl">,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<number> {
  const pending = await db
    .select({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      payload: notifications.payload,
      attempts: notifications.emailAttempts,
      email: users.email,
    })
    .from(notifications)
    .innerJoin(users, eq(notifications.userId, users.id))
    .where(
      and(isNull(notifications.emailedAt), lt(notifications.emailAttempts, MAX_EMAIL_ATTEMPTS)),
    )
    .limit(200);

  let sent = 0;
  for (const row of pending) {
    const formInstanceId = (row.payload as { formInstanceId?: string }).formInstanceId;
    const link = formInstanceId ? `${config.baseUrl}/forms/${formInstanceId}` : config.baseUrl;
    try {
      await transport.sendMail({
        from: config.from,
        to: row.email,
        subject: `[edc-core] ${row.title}`,
        text: `${row.body}\n\n${link}`,
      });
      await db
        .update(notifications)
        .set({ emailedAt: new Date() })
        .where(eq(notifications.id, row.id));
      sent += 1;
    } catch (err) {
      log?.warn({ err, notificationId: row.id }, "notification email failed");
      await db
        .update(notifications)
        .set({ emailAttempts: row.attempts + 1 })
        .where(eq(notifications.id, row.id));
    }
  }
  return sent;
}

const TICK_LOCK = "edc-core:notify-scan";

export function registerScheduler(app: FastifyInstance): void {
  const config = loadSchedulerConfig();
  if (config.scanMinutes <= 0) return;
  const anomalyConfig = loadAnomalyConfig();
  const emailConfig = loadEmailConfig();
  const transport = emailConfig ? createEmailTransport(emailConfig) : null;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Session-level try-lock: concurrent tickers (or a second instance)
      // skip rather than double-scan.
      const lock = await app.db.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_lock(hashtextextended(${TICK_LOCK}, 0)) AS locked`,
      );
      if (!lock[0]?.locked) return;
      try {
        const overdue = await scanOverdueForms(app.db, config.overdueDays);
        if (overdue > 0) app.log.info({ overdue }, "overdue-form notifications created");
        const anomalies = await scanSecurityAnomalies(app.db, anomalyConfig);
        if (anomalies > 0) app.log.warn({ anomalies }, "security anomalies detected");
        if (transport && emailConfig) {
          const sent = await dispatchEmails(app.db, transport, emailConfig, app.log);
          if (sent > 0) app.log.info({ sent }, "notification emails sent");
        }
      } finally {
        await app.db.execute(sql`SELECT pg_advisory_unlock(hashtextextended(${TICK_LOCK}, 0))`);
      }
    } catch (err) {
      app.log.error({ err }, "notification scheduler tick failed");
    } finally {
      running = false;
    }
  };

  let timer: NodeJS.Timeout | null = null;
  app.addHook("onReady", async () => {
    timer = setInterval(tick, config.scanMinutes * 60_000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
}
