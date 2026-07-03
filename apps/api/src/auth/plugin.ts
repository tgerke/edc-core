import { loginRequestSchema } from "@edc-core/schemas";
import cookie from "@fastify/cookie";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/client.js";
import { type AuthConfig, loadAuthConfig } from "./config.js";
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

  await app.register(cookie);
  app.decorate("db", opts.db);
  app.decorate("authService", service);
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request) => {
    const token = extractToken(request);
    request.user = token ? await service.validateSession(token) : null;
  });

  app.post("/auth/login", async (request, reply) => {
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
    };
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
