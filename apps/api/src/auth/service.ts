import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, sessions, users } from "../db/schema/index.js";
import type { AuthConfig } from "./config.js";
import { verifyPassword } from "./password.js";

export type LoginResult =
  | { ok: true; token: string; userId: string }
  | { ok: false; reason: "invalid_credentials" | "locked" | "deactivated" };

export interface AuthenticatedUser {
  id: string;
  username: string;
  fullName: string;
  isSystemAdmin: boolean;
  sessionId: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: AuthConfig,
  ) {}

  async login(
    username: string,
    password: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<LoginResult> {
    const [user] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!user) {
      // Unknown usernames can't be audited (actor FK); constant-ish response.
      await verifyPassword(
        "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        password,
      );
      return { ok: false, reason: "invalid_credentials" };
    }

    if (user.status === "deactivated") return { ok: false, reason: "deactivated" };
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return { ok: false, reason: "locked" };
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      const failedCount = user.failedLoginCount + 1;
      const lock = failedCount >= this.config.maxFailedLogins;
      const lockedUntil = lock ? new Date(Date.now() + this.config.lockoutMinutes * 60_000) : null;
      await this.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ failedLoginCount: failedCount, lockedUntil, updatedAt: new Date() })
          .where(eq(users.id, user.id));
        await tx.insert(auditEvents).values({
          actorId: user.id,
          action: lock ? "auth.lockout" : "auth.login_failed",
          entityType: "user",
          entityId: user.id,
          newValue: { failedLoginCount: failedCount },
        });
      });
      return { ok: false, reason: lock ? "locked" : "invalid_credentials" };
    }

    const token = randomBytes(32).toString("base64url");
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      await tx.insert(sessions).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + this.config.sessionAbsoluteHours * 3_600_000),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      await tx.insert(auditEvents).values({
        actorId: user.id,
        action: "auth.login",
        entityType: "user",
        entityId: user.id,
      });
    });

    return { ok: true, token, userId: user.id };
  }

  /** Validates a bearer token; slides the idle window on success. */
  async validateSession(token: string): Promise<AuthenticatedUser | null> {
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
      .limit(1);
    if (!row) return null;

    const now = Date.now();
    const idleDeadline = row.session.lastSeenAt.getTime() + this.config.sessionIdleMinutes * 60_000;
    if (now > row.session.expiresAt.getTime() || now > idleDeadline) return null;
    if (row.user.status !== "active") return null;

    await this.db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, row.session.id));

    return {
      id: row.user.id,
      username: row.user.username,
      fullName: row.user.fullName,
      isSystemAdmin: row.user.isSystemAdmin,
      sessionId: row.session.id,
    };
  }

  async logout(sessionId: string, actorId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
      await tx.insert(auditEvents).values({
        actorId,
        action: "auth.logout",
        entityType: "session",
        entityId: sessionId,
      });
    });
  }
}
