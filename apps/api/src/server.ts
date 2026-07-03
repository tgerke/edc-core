import { healthResponseSchema } from "@edc-core/schemas";
import Fastify, { type FastifyInstance } from "fastify";

export const API_VERSION = "0.0.1";

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get("/health", async () => {
    return healthResponseSchema.parse({
      status: "ok",
      service: "edc-core-api",
      version: API_VERSION,
      time: new Date().toISOString(),
    });
  });

  return server;
}
