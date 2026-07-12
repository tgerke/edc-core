import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, reauthGrants, sessions, users } from "../db/schema/index.js";
import type { AuthConfig } from "./config.js";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "./password.js";

export type LoginResult =
  | { ok: true; token: string; userId: string }
  | { ok: false; reason: "invalid_credentials" | "locked" | "deactivated" };

export type AuthMethod = "password" | "oidc";

/**
 * Part 11 re-auth at signing, by either credential mechanism: password
 * re-entry, or a single-use grant minted by a fresh interactive IdP login.
 */
export type ReauthInput =
  | { method: "password"; username: string; password: string }
  | { method: "oidc"; reauthGrant: string };

export interface AuthenticatedUser {
  id: string;
  username: string;
  fullName: string;
  isSystemAdmin: boolean;
  /** False for OIDC-provisioned accounts with no local password. */
  hasPassword: boolean;
  /** Temporary admin-issued credential: gated to the change-password flow. */
  mustChangePassword: boolean;
  sessionId: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Kills every live session of an account — deactivation and admin password
 * reset must take effect immediately, not at next idle timeout (E6-05
 * "timely revocation"). Returns the number of sessions revoked.
 */
export async function revokeUserSessions(db: Db, userId: string): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}

// Constant-ish response for unknown users / passwordless accounts.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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
      await verifyPassword(DUMMY_HASH, password);
      return { ok: false, reason: "invalid_credentials" };
    }

    if (user.status === "deactivated") return { ok: false, reason: "deactivated" };
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return { ok: false, reason: "locked" };
    }

    const valid = await verifyPassword(user.passwordHash ?? DUMMY_HASH, password);
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

    const token = await this.createSession(user.id, "password", meta);
    return { ok: true, token, userId: user.id };
  }

  /**
   * Issues a session token after credentials have been verified by either
   * mechanism. Resets lockout counters and audits the login.
   */
  async createSession(
    userId: string,
    authMethod: AuthMethod,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await tx.insert(sessions).values({
        userId,
        tokenHash: hashToken(token),
        authMethod,
        expiresAt: new Date(Date.now() + this.config.sessionAbsoluteHours * 3_600_000),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
      await tx.insert(auditEvents).values({
        actorId: userId,
        action: "auth.login",
        entityType: "user",
        entityId: userId,
        newValue: { authMethod },
      });
    });
    return token;
  }

  /**
   * Mints a single-use re-authentication grant after a fresh interactive IdP
   * login (the OIDC counterpart of password re-entry at signing). The raw
   * token goes back to the browser; only its hash is stored.
   */
  async mintReauthGrant(userId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    // Same freshness window as the auth_time check that gates minting.
    const ttlSeconds = this.config.oidc?.reauthMaxAgeSeconds ?? 120;
    await this.db.insert(reauthGrants).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
    return token;
  }

  /**
   * Part 11 §11.200(a) re-authentication at signing: the signer re-executes
   * authentication, which must resolve to the session user — nobody signs as
   * anyone else. Password re-entry, or a single-use grant from a fresh
   * interactive IdP login (prompt=login, auth_time-checked). Password
   * failures count toward lockout exactly like login failures (§11.300(d))
   * and are audited as signature attempts.
   */
  async reauthenticate(
    actorId: string,
    input: ReauthInput,
  ): Promise<{ ok: true } | { ok: false; reason: "invalid_credentials" | "locked" }> {
    if (input.method === "oidc") return this.consumeReauthGrant(actorId, input.reauthGrant);

    const [user] = await this.db.select().from(users).where(eq(users.id, actorId)).limit(1);
    if (!user || user.status !== "active") return { ok: false, reason: "invalid_credentials" };
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return { ok: false, reason: "locked" };
    }

    const valid =
      user.username === input.username &&
      (await verifyPassword(user.passwordHash ?? DUMMY_HASH, input.password));
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
          action: lock ? "auth.lockout" : "signature.reauth_failed",
          entityType: "user",
          entityId: user.id,
          newValue: { failedLoginCount: failedCount },
        });
      });
      return { ok: false, reason: lock ? "locked" : "invalid_credentials" };
    }

    await this.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return { ok: true };
  }

  /**
   * Atomically consumes a re-auth grant: the conditional UPDATE guarantees
   * single use even under concurrent attempts. A grant burned by a signature
   * that later conflicts simply forces a fresh IdP re-auth.
   */
  private async consumeReauthGrant(
    actorId: string,
    grant: string,
  ): Promise<{ ok: true } | { ok: false; reason: "invalid_credentials" }> {
    const [consumed] = await this.db
      .update(reauthGrants)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(reauthGrants.tokenHash, hashToken(grant)),
          eq(reauthGrants.userId, actorId),
          isNull(reauthGrants.consumedAt),
          gt(reauthGrants.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!consumed) {
      await this.db.insert(auditEvents).values({
        actorId,
        action: "signature.reauth_failed",
        entityType: "user",
        entityId: actorId,
        newValue: { method: "oidc" },
      });
      return { ok: false, reason: "invalid_credentials" };
    }
    return { ok: true };
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
      hasPassword: row.user.passwordHash !== null,
      mustChangePassword: row.user.mustChangePassword,
      sessionId: row.session.id,
    };
  }

  /**
   * Self-service password change (the only way a mustChangePassword gate
   * lifts). Requires the current password even for temporary credentials —
   * possession of the session alone is not enough — and failures count
   * toward lockout exactly like login failures (§11.300(d)). Every other
   * session of the account is revoked on success.
   */
  async changePassword(
    actor: AuthenticatedUser,
    input: { currentPassword: string; newPassword: string },
  ): Promise<
    { ok: true } | { ok: false; code: "invalid_credentials" | "locked" | "policy"; message: string }
  > {
    const [user] = await this.db.select().from(users).where(eq(users.id, actor.id)).limit(1);
    if (!user || user.status !== "active" || user.passwordHash === null) {
      return { ok: false, code: "invalid_credentials", message: "invalid credentials" };
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return { ok: false, code: "locked", message: "account is locked" };
    }

    const valid = await verifyPassword(user.passwordHash, input.currentPassword);
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
          newValue: { failedLoginCount: failedCount, context: "change_password" },
        });
      });
      return lock
        ? { ok: false, code: "locked", message: "account is locked" }
        : { ok: false, code: "invalid_credentials", message: "current password is incorrect" };
    }

    const violation = validatePasswordPolicy(input.newPassword, this.config.passwordMinLength);
    if (violation) return { ok: false, code: "policy", message: violation };

    const newHash = await hashPassword(input.newPassword);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: newHash,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      await tx.insert(auditEvents).values({
        actorId: user.id,
        action: "auth.password_changed",
        entityType: "user",
        entityId: user.id,
      });
      // A changed password invalidates every other session: whoever held the
      // old credential is out, only the changing session survives.
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sessions.userId, user.id),
            isNull(sessions.revokedAt),
            ne(sessions.id, actor.sessionId),
          ),
        );
    });
    return { ok: true };
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
