import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { accessLog, auditEvents, securityAnomalies, users } from "../db/schema/index.js";
import { notify } from "./notifications.js";

/**
 * Security anomaly detection (E6-06): ICH E6(R3) §4.3.3(b) asks for ongoing
 * measures to detect security breaches ("system monitoring"); §3.16.1(w) for
 * processes to report incidents. Three rules sweep the evidence the system
 * already records:
 *
 *  - failed_login_burst: ≥ threshold 401 responses from one source address
 *    inside the scan window (access_log) — the cross-account signal the
 *    per-account lockout cannot see.
 *  - lockout: every auth.lockout audit event — an account under repeated
 *    failed authentication.
 *  - session_binding_violation: every auth.session_binding_violation audit
 *    event — a token replayed from a different client (already revoked by
 *    the auth layer; surfaced here for review).
 *
 * Findings are materialised once (dedupe_key is unique) and fan out to
 * system administrators through the notification outbox, so re-scans and
 * concurrent tickers are no-ops.
 */

export interface AnomalyConfig {
  /** 401s from one IP inside the window before it counts as a burst;
   * 0 disables the burst rule. */
  failedLoginThreshold: number;
  /** Trailing window (minutes) for the burst rule, and its dedupe bucket. */
  windowMinutes: number;
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

export function loadAnomalyConfig(): AnomalyConfig {
  return {
    failedLoginThreshold: envNonNegativeInt("EDC_ANOMALY_FAILED_LOGIN_THRESHOLD", 10),
    windowMinutes: Math.max(1, envNonNegativeInt("EDC_ANOMALY_WINDOW_MINUTES", 15)),
  };
}

interface NewAnomaly {
  kind: "failed_login_burst" | "lockout" | "session_binding_violation";
  severity: "warning" | "critical";
  userId: string | null;
  ip: string | null;
  summary: string;
  details: Record<string, unknown>;
  dedupeKey: string;
}

/** Audit-driven rules look this far back; per-event dedupe keys make the
 * generous window safe and let a restarted scheduler catch up. */
const AUDIT_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Runs the detection rules and inserts one anomaly per new finding,
 * notifying system administrators about each. Returns the number of new
 * anomalies. `scope` exists for tests against a shared database: when given,
 * the burst rule only considers `scope.ip` and the audit rules only
 * `scope.userId` (a rule with no scope key is skipped).
 */
export async function scanSecurityAnomalies(
  db: Db,
  config: AnomalyConfig,
  scope?: { ip?: string; userId?: string },
): Promise<number> {
  const now = Date.now();
  const windowMs = config.windowMinutes * 60_000;
  const found: NewAnomaly[] = [];

  if (config.failedLoginThreshold > 0 && (!scope || scope.ip)) {
    const windowStart = new Date(now - windowMs);
    // Dedupe bucket aligned to the epoch: one anomaly per source per
    // window-length period, however often the scan runs.
    const bucket = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
    const bursts = await db
      .select({ ip: accessLog.ip, count: sql<number>`count(*)::int` })
      .from(accessLog)
      .where(
        and(
          eq(accessLog.statusCode, 401),
          gte(accessLog.occurredAt, windowStart),
          isNotNull(accessLog.ip),
          ...(scope?.ip ? [eq(accessLog.ip, scope.ip)] : []),
        ),
      )
      .groupBy(accessLog.ip)
      .having(sql`count(*) >= ${config.failedLoginThreshold}`);
    for (const burst of bursts) {
      if (!burst.ip) continue;
      found.push({
        kind: "failed_login_burst",
        severity: "critical",
        userId: null,
        ip: burst.ip,
        summary: `${burst.count} failed authentications from ${burst.ip} within ${config.windowMinutes} minutes`,
        details: {
          count: burst.count,
          windowStart: windowStart.toISOString(),
          windowEnd: new Date(now).toISOString(),
        },
        dedupeKey: `failed_login_burst:${burst.ip}:${bucket}`,
      });
    }
  }

  if (!scope || scope.userId) {
    const events = await db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        actorId: auditEvents.actorId,
        newValue: auditEvents.newValue,
        username: users.username,
      })
      .from(auditEvents)
      .innerJoin(users, eq(auditEvents.actorId, users.id))
      .where(
        and(
          inArray(auditEvents.action, ["auth.lockout", "auth.session_binding_violation"]),
          gte(auditEvents.occurredAt, new Date(now - AUDIT_LOOKBACK_MS)),
          ...(scope?.userId ? [eq(auditEvents.actorId, scope.userId)] : []),
        ),
      );
    for (const event of events) {
      if (event.action === "auth.lockout") {
        found.push({
          kind: "lockout",
          severity: "warning",
          userId: event.actorId,
          ip: null,
          summary: `Account ${event.username} locked after repeated failed logins`,
          details: { auditEventId: String(event.id) },
          dedupeKey: `lockout:${event.id}`,
        });
      } else {
        const ip = (event.newValue as { ip?: string | null } | null)?.ip ?? null;
        found.push({
          kind: "session_binding_violation",
          severity: "critical",
          userId: event.actorId,
          ip,
          summary: `Session for ${event.username} presented by a different client — revoked`,
          details: { auditEventId: String(event.id) },
          dedupeKey: `session_binding_violation:${event.id}`,
        });
      }
    }
  }

  if (found.length === 0) return 0;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(securityAnomalies)
      .values(found)
      .onConflictDoNothing({ target: securityAnomalies.dedupeKey })
      .returning({
        id: securityAnomalies.id,
        kind: securityAnomalies.kind,
        severity: securityAnomalies.severity,
        summary: securityAnomalies.summary,
      });
    if (inserted.length === 0) return 0;

    const admins = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isSystemAdmin, true), eq(users.status, "active")));
    await notify(
      tx as unknown as Db,
      inserted.flatMap((anomaly) =>
        admins.map((admin) => ({
          userId: admin.id,
          type: "security.anomaly" as const,
          title: `Security anomaly: ${anomaly.kind.replaceAll("_", " ")}`,
          body: anomaly.summary,
          payload: { anomalyId: anomaly.id, kind: anomaly.kind, severity: anomaly.severity },
          dedupeKey: anomaly.id,
        })),
      ),
    );
    return inserted.length;
  });
}

export type AcknowledgeResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "already_acknowledged" };

/**
 * Records the response to an anomaly (E6(R3) §3.16.1(w) reporting): stamps
 * the reviewer and note on the row and writes the acknowledgement to the
 * audit trail in the same transaction.
 */
export async function acknowledgeAnomaly(
  db: Db,
  input: { anomalyId: string; userId: string; note?: string },
): Promise<AcknowledgeResult> {
  return db.transaction(async (tx) => {
    const [anomaly] = await tx
      .select({ id: securityAnomalies.id, acknowledgedAt: securityAnomalies.acknowledgedAt })
      .from(securityAnomalies)
      .where(eq(securityAnomalies.id, input.anomalyId))
      .limit(1);
    if (!anomaly) return { ok: false, code: "not_found" } as const;
    if (anomaly.acknowledgedAt) return { ok: false, code: "already_acknowledged" } as const;

    await tx
      .update(securityAnomalies)
      .set({
        acknowledgedAt: new Date(),
        acknowledgedBy: input.userId,
        acknowledgedNote: input.note ?? null,
      })
      .where(eq(securityAnomalies.id, input.anomalyId));
    await tx.insert(auditEvents).values({
      actorId: input.userId,
      action: "security.anomaly_acknowledged",
      entityType: "security_anomaly",
      entityId: input.anomalyId,
      newValue: { acknowledged: true },
      reason: input.note ?? null,
    });
    return { ok: true } as const;
  });
}
