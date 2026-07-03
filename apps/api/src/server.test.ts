import { healthResponseSchema } from "@edc-core/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("GET /health", () => {
  const server = buildServer();

  beforeAll(async () => {
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns a schema-valid health payload", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const parsed = healthResponseSchema.parse(response.json());
    expect(parsed.service).toBe("edc-core-api");
  });
});
