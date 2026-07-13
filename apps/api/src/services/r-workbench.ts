import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { databaseUrl } from "../db/client.js";
import {
  auditEvents,
  snapshots,
  users,
  workbenchExecutions,
  workbenchScripts,
  workbenchScriptVersions,
} from "../db/schema/index.js";
import { lakeDataPath } from "./lake.js";
import type { SnapshotManifest } from "./snapshots.js";
import { WorkbenchError } from "./workbench.js";

const EXECUTION_TIMEOUT_MS = 60_000;

export type EngineLanguage = "r" | "python";

const ENGINES: Record<
  EngineLanguage,
  { label: string; urlEnv: string; catalogEnv: string; lakeEnv: string; defaultUrl: string }
> = {
  r: {
    label: "R",
    urlEnv: "R_ENGINE_URL",
    catalogEnv: "R_ENGINE_CATALOG_URL",
    lakeEnv: "R_ENGINE_LAKE_PATH",
    defaultUrl: "http://localhost:8000",
  },
  python: {
    label: "Python",
    urlEnv: "PY_ENGINE_URL",
    catalogEnv: "PY_ENGINE_CATALOG_URL",
    lakeEnv: "PY_ENGINE_LAKE_PATH",
    defaultUrl: "http://localhost:8001",
  },
};

function engineUrl(language: EngineLanguage): string {
  return process.env[ENGINES[language].urlEnv] ?? ENGINES[language].defaultUrl;
}

// An engine may see Postgres and the lake at different addresses/paths
// than the API (it runs in its own container): compose sets these; local
// dev against a host-run engine falls back to the API's own view.
function engineCatalogUri(language: EngineLanguage): string {
  return process.env[ENGINES[language].catalogEnv] ?? databaseUrl();
}
function engineLakePath(language: EngineLanguage, catalogSchema: string): string {
  return path.join(process.env[ENGINES[language].lakeEnv] ?? lakeDataPath(), catalogSchema);
}

export interface SavedScript {
  id: string;
  name: string;
  language: "r" | "python" | "sql";
  version: number;
  content: string;
  updatedBy: string;
  updatedAt: Date;
}

/** Saving is append-only: same name → new version row (E6-04 traceability). */
export async function saveScript(
  db: Db,
  input: {
    studyId: string;
    name: string;
    language: "r" | "python" | "sql";
    content: string;
    actorId: string;
  },
): Promise<SavedScript> {
  return db.transaction(async (tx) => {
    let [script] = await tx
      .select()
      .from(workbenchScripts)
      .where(
        and(eq(workbenchScripts.studyId, input.studyId), eq(workbenchScripts.name, input.name)),
      );
    if (script && script.language !== input.language) {
      throw new WorkbenchError(
        "invalid",
        `script ${input.name} is ${script.language}, not ${input.language}`,
      );
    }
    if (!script) {
      [script] = await tx
        .insert(workbenchScripts)
        .values({
          studyId: input.studyId,
          name: input.name,
          language: input.language,
          createdBy: input.actorId,
        })
        .returning();
    }
    if (!script) throw new WorkbenchError("invalid", "script insert returned no row");
    const [latest] = await tx
      .select()
      .from(workbenchScriptVersions)
      .where(eq(workbenchScriptVersions.scriptId, script.id))
      .orderBy(desc(workbenchScriptVersions.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;
    const [row] = await tx
      .insert(workbenchScriptVersions)
      .values({ scriptId: script.id, version, content: input.content, createdBy: input.actorId })
      .returning();
    if (!row) throw new WorkbenchError("invalid", "script version insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "workbench.script_saved",
      entityType: "workbench_script",
      entityId: script.id,
      newValue: { name: input.name, language: input.language, version },
    });
    return {
      id: script.id,
      name: script.name,
      language: script.language,
      version,
      content: row.content,
      updatedBy: input.actorId,
      updatedAt: row.createdAt,
    };
  });
}

export async function listScripts(db: Db, studyId: string): Promise<SavedScript[]> {
  const rows = await db
    .select({
      id: workbenchScripts.id,
      name: workbenchScripts.name,
      language: workbenchScripts.language,
      version: workbenchScriptVersions.version,
      content: workbenchScriptVersions.content,
      updatedBy: users.username,
      updatedAt: workbenchScriptVersions.createdAt,
    })
    .from(workbenchScripts)
    .innerJoin(workbenchScriptVersions, eq(workbenchScriptVersions.scriptId, workbenchScripts.id))
    .innerJoin(users, eq(workbenchScriptVersions.createdBy, users.id))
    .where(eq(workbenchScripts.studyId, studyId))
    .orderBy(workbenchScripts.name, desc(workbenchScriptVersions.version));
  // Latest version per script.
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

interface EngineResponse {
  ok: boolean;
  stdout?: string;
  error?: string | null;
  resultColumns?: string[] | null;
  resultJson?: string | null;
  elapsedMs?: number;
}

/**
 * Run an R or Python script against a pinned snapshot in the matching
 * engine sidecar and persist the full execution record — exact content,
 * snapshot, logs, outputs (E6-04). Both engines apply the same containment
 * as the SQL workbench: study-scoped READ_ONLY lake, version-pinned views,
 * locked DuckDB session, fresh subprocess per run.
 */
export async function executeScript(
  db: Db,
  input: {
    studyId: string;
    snapshotId: string;
    language: EngineLanguage;
    content: string;
    scriptId?: string | undefined;
    scriptVersion?: number | undefined;
    actorId: string;
  },
) {
  const [snapshot] = await db.select().from(snapshots).where(eq(snapshots.id, input.snapshotId));
  if (!snapshot || snapshot.studyId !== input.studyId) {
    throw new WorkbenchError("not_found", "snapshot not found in this study");
  }
  if (snapshot.status !== "published" || snapshot.lakeVersion === null) {
    throw new WorkbenchError("invalid", `snapshot is ${snapshot.status}, not published`);
  }
  const manifest = snapshot.manifest as SnapshotManifest;

  let engine: EngineResponse;
  const started = Date.now();
  try {
    const res = await fetch(`${engineUrl(input.language)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        script: input.content,
        catalogUri: engineCatalogUri(input.language),
        dataPath: engineLakePath(input.language, manifest.schema),
        metadataSchema: manifest.schema,
        version: Number(snapshot.lakeVersion),
        tables: manifest.tables.map((t) => t.table),
        timeoutMs: EXECUTION_TIMEOUT_MS,
      }),
      signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS + 30_000),
    });
    engine = (await res.json()) as EngineResponse;
  } catch (err) {
    throw new WorkbenchError(
      "engine",
      `${ENGINES[input.language].label} engine unreachable at ${engineUrl(input.language)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const elapsedMs = engine.elapsedMs ?? Date.now() - started;
  // plumber serializes R NULL as {} — only trust string errors.
  const engineError = typeof engine.error === "string" && engine.error ? engine.error : null;

  const result =
    engine.ok && engine.resultColumns && engine.resultJson
      ? { columns: engine.resultColumns, rows: JSON.parse(engine.resultJson) as unknown[][] }
      : null;

  return db.transaction(async (tx) => {
    const [execution] = await tx
      .insert(workbenchExecutions)
      .values({
        studyId: input.studyId,
        snapshotId: input.snapshotId,
        scriptId: input.scriptId ?? null,
        scriptVersion: input.scriptVersion ?? null,
        language: input.language,
        content: input.content,
        status: engine.ok ? "succeeded" : "failed",
        stdout: engine.stdout ?? null,
        error: engineError,
        result,
        elapsedMs,
        executedBy: input.actorId,
      })
      .returning();
    if (!execution) throw new WorkbenchError("invalid", "execution insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "workbench.executed",
      entityType: "workbench_execution",
      entityId: execution.id,
      newValue: {
        language: input.language,
        snapshotId: input.snapshotId,
        lakeVersion: String(snapshot.lakeVersion),
        status: execution.status,
        elapsedMs,
        ...(input.scriptId ? { scriptId: input.scriptId, scriptVersion: input.scriptVersion } : {}),
      },
    });
    return execution;
  });
}

export async function listExecutions(db: Db, studyId: string, limit = 20) {
  return db
    .select({
      id: workbenchExecutions.id,
      snapshotId: workbenchExecutions.snapshotId,
      scriptId: workbenchExecutions.scriptId,
      scriptVersion: workbenchExecutions.scriptVersion,
      language: workbenchExecutions.language,
      content: workbenchExecutions.content,
      status: workbenchExecutions.status,
      stdout: workbenchExecutions.stdout,
      error: workbenchExecutions.error,
      result: workbenchExecutions.result,
      elapsedMs: workbenchExecutions.elapsedMs,
      executedBy: users.username,
      executedAt: workbenchExecutions.executedAt,
    })
    .from(workbenchExecutions)
    .innerJoin(users, eq(workbenchExecutions.executedBy, users.id))
    .where(eq(workbenchExecutions.studyId, studyId))
    .orderBy(desc(workbenchExecutions.executedAt))
    .limit(limit);
}
