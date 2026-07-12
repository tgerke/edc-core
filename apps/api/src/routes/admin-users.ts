import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hashPassword } from "../auth/password.js";
import { requireSystemAdmin } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { revokeUserSessions } from "../auth/service.js";
import type { Db } from "../db/client.js";
import { auditEvents, users } from "../db/schema/index.js";
import { isUniqueViolation } from "../services/lab-imports.js";

/**
 * Account lifecycle (system administration, like study creation). Accounts
 * are deactivated, never deleted (21 CFR 11.100(a): signatures stay
 * attributable indefinitely). Administrator-issued credentials are temporary:
 * the generated password is returned exactly once, never stored or logged,
 * and the holder is gated to the change-password flow until they set their
 * own (must_change_password + the auth plugin's request gate).
 */

const userCreateSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._@-]+$/, "letters, digits, . _ @ - only"),
  email: z.email().max(200),
  fullName: z.string().min(1).max(200),
  isSystemAdmin: z.boolean().optional(),
  /** "password": generated temporary password. "sso": no local password —
   * the account links to the IdP by verified email at first login. */
  auth: z.enum(["password", "sso"]),
});

const systemAdminSchema = z.object({ isSystemAdmin: z.boolean() });

const USER_COLUMNS = {
  id: users.id,
  username: users.username,
  email: users.email,
  fullName: users.fullName,
  status: users.status,
  isSystemAdmin: users.isSystemAdmin,
  mustChangePassword: users.mustChangePassword,
  lockedUntil: users.lockedUntil,
  passwordChangedAt: users.passwordChangedAt,
  createdAt: users.createdAt,
};

function generatedPassword(): string {
  return randomBytes(18).toString("base64url");
}

export const adminUserRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireSystemAdmin());

  app.get("/admin/users", async () => {
    const rows = await app.db
      .select({ ...USER_COLUMNS, passwordHash: users.passwordHash, oidcSubject: users.oidcSubject })
      .from(users)
      .orderBy(desc(users.createdAt));
    return rows.map(({ passwordHash, oidcSubject, ...row }) => ({
      ...row,
      hasPassword: passwordHash !== null,
      ssoLinked: oidcSubject !== null,
    }));
  });

  app.post("/admin/users", async (request, reply) => {
    const parsed = userCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const actor = request.user as AuthenticatedUser;
    const input = parsed.data;
    const password = input.auth === "password" ? generatedPassword() : null;

    try {
      const created = await app.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({
            username: input.username,
            email: input.email,
            fullName: input.fullName,
            isSystemAdmin: input.isSystemAdmin ?? false,
            passwordHash: password ? await hashPassword(password) : null,
            mustChangePassword: password !== null,
          })
          .returning(USER_COLUMNS);
        if (!user) throw new Error("user insert returned no row");
        await tx.insert(auditEvents).values({
          actorId: actor.id,
          action: "user.created",
          entityType: "user",
          entityId: user.id,
          newValue: {
            username: input.username,
            email: input.email,
            fullName: input.fullName,
            isSystemAdmin: input.isSystemAdmin ?? false,
            auth: input.auth,
          },
        });
        return user;
      });
      // The only response that ever carries the temporary password.
      return reply.code(201).send({
        ...created,
        hasPassword: password !== null,
        ssoLinked: false,
        ...(password ? { temporaryPassword: password } : {}),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: "username or email already in use" });
      }
      throw err;
    }
  });

  app.post("/admin/users/:userId/deactivate", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const actor = request.user as AuthenticatedUser;
    if (userId === actor.id) {
      return reply.code(400).send({ error: "you cannot deactivate your own account" });
    }
    const result = await app.db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ status: "deactivated", updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning(USER_COLUMNS);
      if (!user) return null;
      const sessionsRevoked = await revokeUserSessions(tx as unknown as Db, userId);
      await tx.insert(auditEvents).values({
        actorId: actor.id,
        action: "user.deactivated",
        entityType: "user",
        entityId: userId,
        newValue: { username: user.username, sessionsRevoked },
      });
      return user;
    });
    if (!result) return reply.code(404).send({ error: "user not found" });
    return result;
  });

  app.post("/admin/users/:userId/reactivate", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const actor = request.user as AuthenticatedUser;
    const result = await app.db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ status: "active", failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning(USER_COLUMNS);
      if (!user) return null;
      await tx.insert(auditEvents).values({
        actorId: actor.id,
        action: "user.reactivated",
        entityType: "user",
        entityId: userId,
        newValue: { username: user.username },
      });
      return user;
    });
    if (!result) return reply.code(404).send({ error: "user not found" });
    return result;
  });

  app.post("/admin/users/:userId/unlock", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const actor = request.user as AuthenticatedUser;
    const result = await app.db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning(USER_COLUMNS);
      if (!user) return null;
      await tx.insert(auditEvents).values({
        actorId: actor.id,
        action: "user.unlocked",
        entityType: "user",
        entityId: userId,
        newValue: { username: user.username },
      });
      return user;
    });
    if (!result) return reply.code(404).send({ error: "user not found" });
    return result;
  });

  app.post("/admin/users/:userId/reset-password", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const actor = request.user as AuthenticatedUser;
    const [existing] = await app.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!existing) return reply.code(404).send({ error: "user not found" });
    if (existing.passwordHash === null) {
      return reply.code(400).send({ error: "this account authenticates through SSO" });
    }

    const password = generatedPassword();
    const hash = await hashPassword(password);
    await app.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: hash,
          passwordChangedAt: new Date(),
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
      const sessionsRevoked = await revokeUserSessions(tx as unknown as Db, userId);
      await tx.insert(auditEvents).values({
        actorId: actor.id,
        action: "user.password_reset",
        entityType: "user",
        entityId: userId,
        newValue: { username: existing.username, sessionsRevoked },
      });
    });
    // The only response that ever carries the temporary password.
    return { ok: true, temporaryPassword: password };
  });

  app.post("/admin/users/:userId/system-admin", async (request, reply) => {
    const parsed = systemAdminSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { userId } = request.params as { userId: string };
    const actor = request.user as AuthenticatedUser;
    if (userId === actor.id) {
      return reply.code(400).send({ error: "you cannot change your own system-admin flag" });
    }
    const result = await app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!before) return null;
      const [user] = await tx
        .update(users)
        .set({ isSystemAdmin: parsed.data.isSystemAdmin, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning(USER_COLUMNS);
      if (!user) return null;
      await tx.insert(auditEvents).values({
        actorId: actor.id,
        action: "user.system_admin_changed",
        entityType: "user",
        entityId: userId,
        oldValue: { isSystemAdmin: before.isSystemAdmin },
        newValue: { isSystemAdmin: parsed.data.isSystemAdmin, username: before.username },
      });
      return user;
    });
    if (!result) return reply.code(404).send({ error: "user not found" });
    return result;
  });
};
