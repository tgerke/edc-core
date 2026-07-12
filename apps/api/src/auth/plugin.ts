import { loginRequestSchema } from "@edc-core/schemas";
import cookie from "@fastify/cookie";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { users } from "../db/schema/index.js";
import { API_KEY_PREFIX } from "./api-keys.js";
import { type AuthConfig, loadAuthConfig } from "./config.js";
import {
  decodeFlowState,
  encodeFlowState,
  newFlowState,
  OidcClient,
  OidcProvisionError,
  provisionOidcUser,
  safeReturnTo,
} from "./oidc.js";
import type { Permission } from "./permissions.js";
import { hasPermission, type PermissionScope } from "./rbac.js";
import { type AuthenticatedUser, AuthService } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
  interface FastifyInstance {
    authService: AuthService;
    db: Db;
  }
}

export const SESSION_COOKIE = "edc_session";
export const OIDC_STATE_COOKIE = "edc_oidc_state";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return request.cookies[SESSION_COOKIE] ?? null;
}

export interface AuthPluginOptions {
  db: Db;
  config?: AuthConfig;
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const config = opts.config ?? loadAuthConfig();
  const service = new AuthService(opts.db, config);
  const oidcClient = config.oidc ? new OidcClient(config.oidc) : null;
  if (oidcClient) {
    oidcClient.warmUp().catch((err) => {
      app.log.error({ err }, "OIDC discovery failed at boot; will retry on first login");
    });
  }

  await app.register(cookie);
  app.decorate("db", opts.db);
  app.decorate("authService", service);
  app.decorateRequest("user", null);
  app.decorateRequest("servicePrincipal", null);

  app.addHook("onRequest", async (request, reply) => {
    const token = extractToken(request);
    // API keys (machine auth) never resolve to a session or a user; routes
    // that accept them opt in via requireRtsmKey.
    request.user =
      token && !token.startsWith(API_KEY_PREFIX) ? await service.validateSession(token) : null;

    // A temporary admin-issued credential (account creation, password reset)
    // can do nothing but become a real one. Server-side, not just UI: the
    // allowlist is the change-password flow and the calls needed to reach it.
    if (request.user?.mustChangePassword) {
      const path = request.url.split("?")[0];
      const allowed =
        path === "/auth/me" ||
        path === "/auth/change-password" ||
        path === "/auth/logout" ||
        path === "/auth/config" ||
        path === "/health";
      if (!allowed) {
        await reply
          .code(403)
          .send({ error: "password change required", code: "password_change_required" });
      }
    }
  });

  app.get("/auth/config", async () => ({
    oidcEnabled: oidcClient !== null,
    oidcOnly: config.oidcOnly,
    providerLabel: config.oidc?.providerLabel ?? null,
    passwordLoginEnabled: !config.oidcOnly,
  }));

  app.post("/auth/login", async (request, reply) => {
    if (config.oidcOnly) {
      // Break-glass for a misconfigured IdP is unsetting EDC_OIDC_ONLY.
      return reply.code(403).send({ error: "password_login_disabled" });
    }
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "username and password are required" });
    }
    const result = await service.login(parsed.data.username, parsed.data.password, {
      ...(request.ip ? { ip: request.ip } : {}),
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
    });
    if (!result.ok) {
      return reply.code(401).send({ error: result.reason });
    }
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
    return { token: result.token };
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user as AuthenticatedUser;
    await service.logout(user.sessionId, user.id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request) => {
    const user = request.user as AuthenticatedUser;
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      isSystemAdmin: user.isSystemAdmin,
      hasPassword: user.hasPassword,
      mustChangePassword: user.mustChangePassword,
    };
  });

  app.post("/auth/change-password", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user as AuthenticatedUser;
    if (!user.hasPassword) {
      return reply.code(400).send({ error: "this account authenticates through SSO" });
    }
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const result = await service.changePassword(user, parsed.data);
    if (!result.ok) {
      const status = result.code === "locked" ? 423 : 400;
      return reply.code(status).send({ error: result.message, code: result.code });
    }
    return { ok: true };
  });

  // ── OIDC (authorization code + PKCE) ──────────────────────────────────
  // Browser-navigation endpoints: errors surface as redirects back into the
  // SPA, not JSON. The flow-state cookie must be sameSite=lax — the IdP's
  // redirect to the callback is a cross-site top-level navigation, which a
  // strict cookie would not accompany. The session cookie stays strict; it
  // is only *set* on the callback response, never required by it.

  const stateCookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  } as const;

  app.get("/auth/oidc/login", async (request, reply) => {
    if (!oidcClient) return reply.code(404).send({ error: "SSO is not configured" });
    const query = request.query as { purpose?: string; returnTo?: string };
    const purpose = query.purpose === "reauth" ? "reauth" : "login";
    const { flow, codeChallenge } = await newFlowState(purpose, safeReturnTo(query.returnTo));
    try {
      const url = await oidcClient.buildAuthorizationUrl(
        { state: flow.state, nonce: flow.nonce, codeChallenge },
        purpose,
      );
      reply.setCookie(OIDC_STATE_COOKIE, encodeFlowState(flow), stateCookieOptions);
      return reply.redirect(url.href);
    } catch (err) {
      request.log.error({ err }, "OIDC authorization redirect failed");
      return reply.code(503).send({ error: "identity provider unreachable" });
    }
  });

  app.get("/auth/oidc/callback", async (request, reply) => {
    if (!oidcClient || !config.oidc)
      return reply.code(404).send({ error: "SSO is not configured" });
    const raw = request.cookies[OIDC_STATE_COOKIE];
    reply.clearCookie(OIDC_STATE_COOKIE, { path: "/" });
    const flow = raw ? decodeFlowState(raw) : null;
    if (!flow) return reply.redirect("/login?error=oidc_state");
    const fail = (code: string) =>
      reply.redirect(
        flow.purpose === "reauth" ? `/reauth-complete#error=${code}` : `/login?error=${code}`,
      );

    // Reconstruct the callback URL on the *registered* redirect URI (the API
    // may sit behind a proxy that rewrites paths); token-endpoint redirect_uri
    // validation requires an exact match.
    const callbackUrl = new URL(config.oidc.redirectUri);
    callbackUrl.search = new URL(request.url, "http://placeholder.invalid").search;

    let claims: Awaited<ReturnType<OidcClient["exchangeCode"]>>;
    try {
      claims = await oidcClient.exchangeCode(callbackUrl, {
        state: flow.state,
        nonce: flow.nonce,
        codeVerifier: flow.codeVerifier,
      });
    } catch (err) {
      request.log.error({ err }, "OIDC code exchange failed");
      return fail("oidc_exchange");
    }

    if (flow.purpose === "reauth") {
      // A grant requires a *fresh* interactive login: max_age=0 obliges the
      // IdP to report auth_time, which must fall inside the re-auth window.
      const authTime = typeof claims.auth_time === "number" ? claims.auth_time : null;
      const age = authTime === null ? Number.POSITIVE_INFINITY : Date.now() / 1000 - authTime;
      if (age > config.oidc.reauthMaxAgeSeconds + 30) return fail("stale_auth");
      const [signer] = await opts.db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.oidcSubject, String(claims.sub)))
        .limit(1);
      if (!signer || signer.status !== "active") return fail("unknown_user");
      const grant = await service.mintReauthGrant(signer.id);
      // Fragment, not query: fragments never reach servers or access logs.
      return reply.redirect(`/reauth-complete#grant=${grant}`);
    }

    try {
      const { userId } = await provisionOidcUser(opts.db, claims);
      const token = await service.createSession(userId, "oidc", {
        ...(request.ip ? { ip: request.ip } : {}),
        ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      });
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
      return reply.redirect(flow.returnTo);
    } catch (err) {
      if (err instanceof OidcProvisionError) return fail(err.code);
      request.log.error({ err }, "OIDC provisioning failed");
      return fail("oidc_provision");
    }
  });
};

export const authPlugin = fp(plugin, { name: "edc-auth" });

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: "authentication required" });
  }
}

export function requireSystemAdmin() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      await reply.code(401).send({ error: "authentication required" });
      return;
    }
    if (!request.user.isSystemAdmin) {
      await reply.code(403).send({ error: "system administrator required" });
    }
  };
}

/**
 * Route guard: 401 unauthenticated, 403 when the permission is not held in
 * the scope the route resolves from its request (P11-04).
 *
 * `allowSystemAdmin` is for administrative permissions only (e.g. the first
 * role grant in a new study, which would otherwise be unreachable). Never
 * set it on clinical capabilities — system administration must not entitle
 * anyone to enter, verify, or sign data.
 */
export function requirePermission(
  permission: Permission,
  resolveScope: (request: FastifyRequest) => PermissionScope,
  opts: { allowSystemAdmin?: boolean } = {},
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      await reply.code(401).send({ error: "authentication required" });
      return;
    }
    if (opts.allowSystemAdmin && request.user.isSystemAdmin) return;
    const allowed = await hasPermission(
      request.server.db,
      request.user.id,
      permission,
      resolveScope(request),
    );
    if (!allowed) {
      await reply.code(403).send({ error: `missing permission: ${permission}` });
    }
  };
}
