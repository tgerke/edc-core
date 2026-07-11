import type { FastifyRequest } from "fastify";
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

export function sendCaptureError(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  err: CaptureError,
) {
  const status = { conflict: 409, not_found: 404, invalid: 400 }[err.code];
  return reply.code(status).send({ error: err.message });
}
