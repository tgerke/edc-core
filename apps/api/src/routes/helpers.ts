import type { FastifyReply, FastifyRequest } from "fastify";
import { MACHINE_TOKEN_PREFIXES, requirePmoKey } from "../auth/api-keys.js";
import { isStudyMember } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import type { CaptureError } from "../services/capture.js";

export function studyScope(request: FastifyRequest) {
  return { studyId: (request.params as { studyId: string }).studyId };
}

export async function requireMembership(request: FastifyRequest): Promise<boolean> {
  const user = request.user as AuthenticatedUser;
  const { studyId } = request.params as { studyId: string };
  return user.isSystemAdmin || (await isStudyMember(request.server.db, user.id, studyId));
}

/**
 * Guard for the read listings a PMO key may reach (ADR-0017): a session user
 * must be a member (or system admin), exactly as before; a machine caller
 * must present a valid `pmo_read` key for this study. Sends its own 401/403
 * and returns false when the reply has gone out. Machine success is visible
 * afterwards as request.servicePrincipal.
 */
export async function requireMemberOrPmoKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (request.user) {
    if (await requireMembership(request)) return true;
    await reply.code(403).send({ error: "not a member of this study" });
    return false;
  }
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (token && MACHINE_TOKEN_PREFIXES.some((p) => token.startsWith(p))) {
    await requirePmoKey(request, reply);
    return request.servicePrincipal !== null;
  }
  await reply.code(401).send({ error: "authentication required" });
  return false;
}

export function sendCaptureError(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  err: CaptureError,
) {
  const status = { conflict: 409, not_found: 404, invalid: 400 }[err.code];
  return reply.code(status).send({ error: err.message });
}
