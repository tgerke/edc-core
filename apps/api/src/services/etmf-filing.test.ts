import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { etmfConfig, fileToEtmf } from "./etmf-filing.js";

/**
 * eTMF filing client against a mock eTMF: verifies the multipart contract
 * (fields, provenance, bearer auth) and that every failure path resolves to
 * { filed: false } rather than throwing — filing must never break the
 * operation that triggered it.
 */

let etmf: Server;
let etmfUrl: string;
let lastRequest: { auth: string | undefined; body: string } | null = null;
// Reads through a call so TS doesn't narrow the closure-mutated variable.
const received = () => lastRequest;
let respondWith: { status: number; body: string } = {
  status: 201,
  body: JSON.stringify({ document_id: "doc-1", version_id: "ver-1" }),
};

beforeAll(async () => {
  etmf = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastRequest = {
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.statusCode = respondWith.status;
      res.setHeader("content-type", "application/json");
      res.end(respondWith.body);
    });
  });
  await new Promise<void>((resolve) => etmf.listen(0, "127.0.0.1", resolve));
  etmfUrl = `http://127.0.0.1:${(etmf.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => etmf.close(() => resolve()));
});

function config(artifacts: Partial<Record<"study_build" | "snapshot", number>> = {}) {
  return { url: etmfUrl, token: "test-token", studyId: "study-uuid", artifacts };
}

describe("etmfConfig", () => {
  it("is null when EDC_ETMF_URL is unset", () => {
    expect(etmfConfig({})).toBeNull();
  });

  it("throws on partial configuration", () => {
    expect(() => etmfConfig({ EDC_ETMF_URL: "http://x" })).toThrow(/missing/);
  });

  it("parses artifact mappings and strips the trailing slash", () => {
    const cfg = etmfConfig({
      EDC_ETMF_URL: "http://x/",
      EDC_ETMF_TOKEN: "t",
      EDC_ETMF_STUDY_ID: "s",
      EDC_ETMF_ARTIFACT_STUDY_BUILD: "9",
    });
    expect(cfg).toEqual({
      url: "http://x",
      token: "t",
      studyId: "s",
      artifacts: { study_build: 9 },
    });
  });

  it("rejects a non-integer artifact id", () => {
    expect(() =>
      etmfConfig({
        EDC_ETMF_URL: "http://x",
        EDC_ETMF_TOKEN: "t",
        EDC_ETMF_STUDY_ID: "s",
        EDC_ETMF_ARTIFACT_SNAPSHOT: "zone-ten",
      }),
    ).toThrow(/positive integer/);
  });
});

describe("fileToEtmf", () => {
  const filing = {
    kind: "study_build" as const,
    title: "Study build v3 (ODM metadata)",
    fileName: "study-build-v3.xml",
    mimeType: "application/xml",
    content: "<ODM/>",
    sourceRef: "study-build:LP101:v3",
  };

  it("posts the multipart contract with provenance and bearer auth", async () => {
    lastRequest = null;
    const result = await fileToEtmf(config({ study_build: 9 }), filing);
    expect(result).toEqual({ filed: true, documentId: "doc-1", versionId: "ver-1" });
    expect(received()?.auth).toBe("Bearer test-token");
    for (const fragment of [
      'name="tmf_artifact_id"',
      'name="study_id"',
      'name="source_system"',
      "edc-core",
      "study-build:LP101:v3",
      'filename="study-build-v3.xml"',
      "<ODM/>",
    ]) {
      expect(received()?.body).toContain(fragment);
    }
  });

  it("skips filing kinds with no artifact mapping", async () => {
    lastRequest = null;
    const result = await fileToEtmf(config(), filing);
    expect(result).toEqual({ filed: false, reason: expect.stringContaining("no eTMF artifact") });
    expect(received()).toBeNull();
  });

  it("resolves { filed: false } on an eTMF error response", async () => {
    respondWith = { status: 403, body: JSON.stringify({ error: "requires 'upload'" }) };
    const result = await fileToEtmf(config({ study_build: 9 }), filing);
    expect(result.filed).toBe(false);
    respondWith = {
      status: 201,
      body: JSON.stringify({ document_id: "doc-1", version_id: "ver-1" }),
    };
  });

  it("resolves { filed: false } when the eTMF is unreachable", async () => {
    const cfg = { ...config({ study_build: 9 }), url: "http://127.0.0.1:1" };
    const result = await fileToEtmf(cfg, filing);
    expect(result.filed).toBe(false);
  });
});
