import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireSystemAdmin } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { CaptureError } from "../services/capture.js";
import { listDictionaries, loadDictionary } from "../services/dictionaries.js";
import { sendCaptureError } from "./helpers.js";

// Normalized dictionary CSVs travel as JSON strings like every other upload
// (the SPA reads the file client-side). MedDRA conversions run ~10 MB;
// WHODrug subsets can be several times that. Files beyond this envelope go
// through the db:load-dictionary script instead.
const DICTIONARY_BODY_LIMIT = 50 * 1024 * 1024;

const uploadSchema = z.object({
  type: z.enum(["MedDRA", "WHODrug"]),
  version: z.string().min(1).max(100),
  content: z.string().min(1),
});

/**
 * Dictionary management is deliberately system-admin only: dictionaries are
 * global, licensed reference data shared across studies, not study content.
 * Study members see bound-dictionary metadata via the coding settings route.
 */
export const dictionaryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/dictionaries", { preHandler: requireSystemAdmin() }, async () => {
    return listDictionaries(app.db);
  });

  app.post(
    "/dictionaries",
    { preHandler: requireSystemAdmin(), bodyLimit: DICTIONARY_BODY_LIMIT },
    async (request, reply) => {
      const parsed = uploadSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;
      try {
        const dictionary = await loadDictionary(app.db, {
          type: parsed.data.type,
          version: parsed.data.version,
          content: parsed.data.content,
          actorId: user.id,
        });
        return reply.code(201).send(dictionary);
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );
};
