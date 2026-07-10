import type { FastifyBaseLogger } from "fastify";

/**
 * eTMF filing (reference integration): pushes study-level artifacts this EDC
 * generates — study-build definitions, snapshot manifests — into an eTMF
 * exposing a multipart document-upload API with filing provenance. The
 * reference target is ctms-core (its ADR-0011); any system with the same
 * interface shape works.
 *
 * Boundary: only study-level artifacts are filed. Subject-level clinical data
 * (casebooks, captured values) never leaves this system through this path.
 *
 * Filing is best-effort and asynchronous: the primary operation (build
 * import, snapshot publish) never waits on, or fails because of, the eTMF.
 * A missed filing is visible in the logs and recoverable by re-filing; a
 * blocked capture workflow is not acceptable.
 */

export interface EtmfConfig {
  /** Base URL of the eTMF API, e.g. http://localhost:8787 */
  url: string;
  /** Bearer token for the machine identity provisioned in the eTMF. */
  token: string;
  /** The eTMF's id for this study (its uuid, not ours). */
  studyId: string;
  /**
   * eTMF artifact ids per filing kind, from the eTMF's live TMF taxonomy —
   * deployment configuration, never inferred here. Unmapped kinds are
   * skipped and logged.
   */
  artifacts: Partial<Record<EtmfFilingKind, number>>;
}

export type EtmfFilingKind = "study_build" | "snapshot";

export interface EtmfFiling {
  kind: EtmfFilingKind;
  title: string;
  fileName: string;
  mimeType: string;
  content: string | Uint8Array;
  /** This system's native reference for the artifact, e.g. "study-build:LP101:v3". */
  sourceRef: string;
}

/** Read filing configuration from the environment; null = integration off. */
export function etmfConfig(env: NodeJS.ProcessEnv = process.env): EtmfConfig | null {
  const url = env.EDC_ETMF_URL;
  if (!url) return null;
  const token = env.EDC_ETMF_TOKEN;
  const studyId = env.EDC_ETMF_STUDY_ID;
  if (!token || !studyId) {
    throw new Error("EDC_ETMF_URL is set but EDC_ETMF_TOKEN or EDC_ETMF_STUDY_ID is missing");
  }
  const artifacts: Partial<Record<EtmfFilingKind, number>> = {};
  for (const [kind, name] of [
    ["study_build", "EDC_ETMF_ARTIFACT_STUDY_BUILD"],
    ["snapshot", "EDC_ETMF_ARTIFACT_SNAPSHOT"],
  ] as const) {
    const raw = env[name];
    if (!raw) continue;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer artifact id, got "${raw}"`);
    }
    artifacts[kind] = parsed;
  }
  return { url: url.replace(/\/$/, ""), token, studyId, artifacts };
}

export type EtmfFilingResult =
  | { filed: true; documentId: string; versionId: string }
  | { filed: false; reason: string };

/**
 * File one artifact. Throws nothing: every failure path resolves to
 * `{ filed: false }` with a reason, so callers can fire-and-forget.
 */
export async function fileToEtmf(
  config: EtmfConfig,
  filing: EtmfFiling,
  log?: FastifyBaseLogger,
): Promise<EtmfFilingResult> {
  const artifactId = config.artifacts[filing.kind];
  if (!artifactId) {
    const reason = `no eTMF artifact mapped for kind "${filing.kind}"`;
    log?.info({ etmf: filing.sourceRef }, `eTMF filing skipped: ${reason}`);
    return { filed: false, reason };
  }

  const form = new FormData();
  const bytes =
    typeof filing.content === "string" ? filing.content : new Uint8Array(filing.content);
  form.set("file", new Blob([bytes], { type: filing.mimeType }), filing.fileName);
  form.set("tmf_artifact_id", String(artifactId));
  form.set("study_id", config.studyId);
  form.set("title", filing.title);
  form.set("source_system", "edc-core");
  form.set("source_ref", filing.sourceRef);

  try {
    const res = await fetch(`${config.url}/documents`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const reason = `eTMF responded ${res.status}: ${body.slice(0, 200)}`;
      log?.warn({ etmf: filing.sourceRef }, `eTMF filing failed: ${reason}`);
      return { filed: false, reason };
    }
    const created = (await res.json()) as { document_id: string; version_id: string };
    log?.info({ etmf: filing.sourceRef, documentId: created.document_id }, "filed to eTMF");
    return { filed: true, documentId: created.document_id, versionId: created.version_id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.warn({ etmf: filing.sourceRef }, `eTMF filing failed: ${reason}`);
    return { filed: false, reason };
  }
}
