import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { apiKeys, auditEvents, roles, userStudyRoles, users } from "../db/schema/index.js";
import { grantRole } from "./rbac.js";

// Machine auth for external integrations. An API key is a bearer credential
// bound to one study, one service-account user, and one scope (ADR-0017):
// 'rtsm' keys reach exactly the assignment-intake POST, 'pmo_read' keys
// exactly the read-only listings. A key never becomes a session and never
// populates request.user; guards pin the scope, so a leaked key of either
// class can do only its own class's work.

// Distinguishes API keys from session tokens so the session hook can skip
// them without a database lookup.
export const API_KEY_PREFIX = "edcrtsm_";
export const PMO_KEY_PREFIX = "edcpmo_";
export const MACHINE_TOKEN_PREFIXES = [API_KEY_PREFIX, PMO_KEY_PREFIX] as const;

export const RTSM_AGENT_ROLE = "rtsm_agent";
export const PMO_AGENT_ROLE = "pmo_agent";

export type ApiKeyScope = "rtsm" | "pmo_read";

// Enough of the raw token for the UI to identify a key, useless as a secret.
const TOKEN_PREFIX_CHARS = 6;

export interface ServicePrincipal {
  apiKeyId: string;
  studyId: string;
  userId: string;
  scope: ApiKeyScope;
}

declare module "fastify" {
  interface FastifyRequest {
    servicePrincipal: ServicePrincipal | null;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A study's integration service account: the users row API-key activity is
 * attributed to (audit rows, item-value versions, and access-log rows need a
 * real actor). Creates it on first use and ensures an unrevoked study-wide
 * role grant — audited via grantRole and revocable like any human grant.
 * The RTSM account's rtsm_agent grant confers integration.rtsm and
 * data.unblind; the PMO account's pmo_agent grant confers integration.read
 * and nothing else (ADR-0017).
 */
async function ensureServiceAccount(
  db: Db,
  input: {
    studyId: string;
    actorId: string;
    kind: "rtsm" | "pmo";
    roleName: string;
    fullName: string;
  },
): Promise<{ userId: string }> {
  const username = `svc-${input.kind}-${input.studyId}`;
  let [account] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!account) {
    [account] = await db
      .insert(users)
      .values({
        username,
        // Deliberately undeliverable: nothing should ever email a machine.
        email: `${username}@service.invalid`,
        fullName: input.fullName,
      })
      .returning();
    if (!account) throw new Error("service account insert returned no row");
    await db.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: `${input.kind}.service_account_created`,
      entityType: "user",
      entityId: account.id,
      newValue: { username },
    });
  }

  const [role] = await db.select().from(roles).where(eq(roles.name, input.roleName)).limit(1);
  if (!role) throw new Error(`${input.roleName} role missing; run migrations`);
  const existing = await db
    .select({ id: userStudyRoles.id })
    .from(userStudyRoles)
    .where(
      and(
        eq(userStudyRoles.userId, account.id),
        eq(userStudyRoles.studyId, input.studyId),
        eq(userStudyRoles.roleId, role.id),
        isNull(userStudyRoles.siteId),
        isNull(userStudyRoles.revokedAt),
      ),
    )
    .limit(1);
  if (existing.length === 0) {
    await grantRole(db, {
      userId: account.id,
      studyId: input.studyId,
      roleId: role.id,
      grantedBy: input.actorId,
    });
  }
  return { userId: account.id };
}

export async function ensureRtsmServiceAccount(
  db: Db,
  input: { studyId: string; actorId: string },
): Promise<{ userId: string }> {
  return ensureServiceAccount(db, {
    ...input,
    kind: "rtsm",
    roleName: RTSM_AGENT_ROLE,
    fullName: "RTSM integration service account",
  });
}

export async function ensurePmoServiceAccount(
  db: Db,
  input: { studyId: string; actorId: string },
): Promise<{ userId: string }> {
  return ensureServiceAccount(db, {
    ...input,
    kind: "pmo",
    roleName: PMO_AGENT_ROLE,
    fullName: "PMO integration service account",
  });
}

export interface MintedApiKey {
  id: string;
  label: string;
  tokenPrefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  /** The raw bearer token. Returned exactly once, never stored. */
  token: string;
}

export async function mintApiKey(
  db: Db,
  input: {
    studyId: string;
    userId: string;
    label: string;
    createdBy: string;
    expiresAt?: Date;
    /** Key class (ADR-0017). Defaults to the original RTSM intake class. */
    scope?: ApiKeyScope;
  },
): Promise<MintedApiKey> {
  const scope = input.scope ?? "rtsm";
  const prefix = scope === "pmo_read" ? PMO_KEY_PREFIX : API_KEY_PREFIX;
  const token = prefix + randomBytes(32).toString("base64url");
  return db.transaction(async (tx) => {
    const [key] = await tx
      .insert(apiKeys)
      .values({
        studyId: input.studyId,
        userId: input.userId,
        scope,
        label: input.label,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, prefix.length + TOKEN_PREFIX_CHARS),
        createdBy: input.createdBy,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    if (!key) throw new Error("api key insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: input.createdBy,
      studyId: input.studyId,
      action: scope === "pmo_read" ? "pmo.key_created" : "rtsm.key_created",
      entityType: "api_key",
      entityId: key.id,
      newValue: {
        label: key.label,
        tokenPrefix: key.tokenPrefix,
        serviceUserId: input.userId,
        expiresAt: key.expiresAt?.toISOString() ?? null,
      },
    });
    return {
      id: key.id,
      label: key.label,
      tokenPrefix: key.tokenPrefix,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      token,
    };
  });
}

/** Validates a raw bearer token; bumps last-used on success. */
export async function validateApiKey(db: Db, token: string): Promise<ServicePrincipal | null> {
  const [row] = await db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.tokenHash, hashToken(token)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.key.expiresAt && row.key.expiresAt.getTime() <= Date.now()) return null;
  if (row.user.status !== "active") return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id));
  return {
    apiKeyId: row.key.id,
    studyId: row.key.studyId,
    userId: row.key.userId,
    scope: row.key.scope,
  };
}

export async function revokeApiKey(
  db: Db,
  input: { studyId: string; keyId: string; actorId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, input.keyId),
          eq(apiKeys.studyId, input.studyId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning();
    if (!row) return false;
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: row.scope === "pmo_read" ? "pmo.key_revoked" : "rtsm.key_revoked",
      entityType: "api_key",
      entityId: row.id,
      oldValue: { label: row.label, tokenPrefix: row.tokenPrefix },
    });
    return true;
  });
}

/**
 * Route guard for integration routes: 401 without a valid, unexpired,
 * unrevoked key of the pinned scope; 403 when the key belongs to a different
 * study than the route. Decorates request.servicePrincipal; request.user
 * stays null. The scope pin is what keeps key classes from crossing — an
 * RTSM key on the read surface (or a read key on the intake) is a 401, the
 * same as no key (ADR-0017).
 */
function requireKeyOfScope(scope: ApiKeyScope) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token || !MACHINE_TOKEN_PREFIXES.some((p) => token.startsWith(p))) {
      await reply.code(401).send({ error: "API key required" });
      return;
    }
    const principal = await validateApiKey(request.server.db, token);
    if (!principal || principal.scope !== scope) {
      await reply.code(401).send({ error: "invalid, expired, or revoked API key" });
      return;
    }
    const { studyId } = request.params as { studyId: string };
    if (principal.studyId !== studyId) {
      await reply.code(403).send({ error: "API key is not valid for this study" });
      return;
    }
    request.servicePrincipal = principal;
  };
}

export const requireRtsmKey = requireKeyOfScope("rtsm");
export const requirePmoKey = requireKeyOfScope("pmo_read");
