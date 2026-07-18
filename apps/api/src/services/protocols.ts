import {
  isUnresolvedItem,
  type MetaDataVersion,
  PROTOCOL_EXT_ATTRS,
  withDisplayText,
} from "@edc-core/odm";
import {
  bcsForActivity,
  type CompileIssue,
  displayLabel,
  parseUsdm,
  primaryStudyDesign,
  soaMatrix,
  studyVersion,
  type TraceRow,
  timingById,
  type UsdmValidationIssue,
  type UsdmWrapper,
  usdmToBuild,
  validateUsdmPackage,
} from "@edc-core/usdm";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  protocolCompilations,
  protocolTraceability,
  protocolVersions,
} from "../db/schema/index.js";
import { importStudyBuild, type StudyBuildDefinition } from "./study-builds.js";

/**
 * The protocol-first build path: a USDM protocol document is a first-class,
 * versioned artifact that compiles into an ODM study build through the same
 * single write path as every other build source (ADR-0003). The compilation
 * is a mutable review workspace; publishing runs importStudyBuild, so
 * everything downstream is unchanged.
 */

export type ProtocolImportResult =
  | {
      ok: true;
      id: string;
      version: number;
      compilationId: string;
      unresolvedCount: number;
      issues: UsdmValidationIssue[];
    }
  | { ok: false; issues: UsdmValidationIssue[] };

export async function importProtocolVersion(
  db: Db,
  input: { studyId: string; content: string; actorId: string; note?: string },
): Promise<ProtocolImportResult> {
  let wrapper: UsdmWrapper;
  let raw: unknown;
  try {
    raw = JSON.parse(input.content);
    wrapper = parseUsdm(raw);
  } catch (err) {
    return {
      ok: false,
      issues: [{ severity: "error", path: "USDM", message: (err as Error).message }],
    };
  }

  const issues = validateUsdmPackage(wrapper);
  if (issues.some((i) => i.severity === "error")) return { ok: false, issues };

  const inserted = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`protocol:${input.studyId}`}, 0))`,
    );
    const [latest] = await tx
      .select({ version: protocolVersions.version })
      .from(protocolVersions)
      .where(eq(protocolVersions.studyId, input.studyId))
      .orderBy(desc(protocolVersions.version))
      .limit(1);

    const [row] = await tx
      .insert(protocolVersions)
      .values({
        studyId: input.studyId,
        version: (latest?.version ?? 0) + 1,
        usdmVersion: wrapper.usdmVersion,
        package: raw,
        note: input.note ?? null,
        createdBy: input.actorId,
      })
      .returning();
    if (!row) throw new Error("protocol version insert returned no row");

    // Compile immediately so the review workspace exists from the start.
    const compiled = usdmToBuild(wrapper, { protocolVersionId: row.id });
    const [compilation] = await tx
      .insert(protocolCompilations)
      .values({
        protocolVersionId: row.id,
        candidate: compiled.definition,
        unresolvedCount: compiled.unresolved.length,
        traceability: compiled.traceability,
        warnings: compiled.warnings,
        updatedBy: input.actorId,
      })
      .returning();
    if (!compilation) throw new Error("protocol compilation insert returned no row");

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "protocol.imported",
      entityType: "protocol_version",
      entityId: row.id,
      newValue: {
        version: row.version,
        usdmVersion: wrapper.usdmVersion,
        unresolvedCount: compiled.unresolved.length,
        note: input.note ?? null,
      },
    });
    return { row, compilation };
  });

  return {
    ok: true,
    id: inserted.row.id,
    version: inserted.row.version,
    compilationId: inserted.compilation.id,
    unresolvedCount: inserted.compilation.unresolvedCount,
    issues,
  };
}

export interface ProtocolConceptStatus {
  usdmId: string;
  name: string;
  conceptCode?: string;
  kind: "concept" | "surrogate";
  status: "resolved" | "draft";
  itemOids: string[];
}

export interface ProtocolSoaSummary {
  encounters: {
    usdmId: string;
    label: string;
    timingLabel?: string;
    windowLabel?: string;
  }[];
  rows: {
    usdmId: string;
    label: string;
    isGroupHeading: boolean;
    encounterIds: string[];
    concepts: ProtocolConceptStatus[];
  }[];
  warnings: CompileIssue[];
  unresolvedCount: number;
}

/**
 * The review screen's data: the protocol's schedule of activities annotated
 * with per-concept resolution status from the current compilation candidate.
 */
export function protocolSoaSummary(
  wrapper: UsdmWrapper,
  candidate: StudyBuildDefinition,
  warnings: CompileIssue[],
): ProtocolSoaSummary | null {
  const version = studyVersion(wrapper);
  const design = version ? primaryStudyDesign(version) : undefined;
  if (!version || !design) return null;

  const itemsByUsdmId = new Map<string, { oids: string[]; anyUnresolved: boolean }>();
  for (const item of candidate.metaDataVersion.itemDefs) {
    const sourceId = item.extra?.[PROTOCOL_EXT_ATTRS.usdmBiomedicalConceptId];
    if (typeof sourceId !== "string") continue;
    const entry = itemsByUsdmId.get(sourceId) ?? { oids: [], anyUnresolved: false };
    entry.oids.push(item.oid);
    if (isUnresolvedItem(item)) entry.anyUnresolved = true;
    itemsByUsdmId.set(sourceId, entry);
  }

  const conceptStatuses = (activityId: string): ProtocolConceptStatus[] => {
    const activity = design.activities.find((a) => a.id === activityId);
    if (!activity) return [];
    const resolved = bcsForActivity(version, activity);
    const statuses: ProtocolConceptStatus[] = [];
    for (const concept of resolved.concepts) {
      const entry = itemsByUsdmId.get(concept.id);
      statuses.push({
        usdmId: concept.id,
        name: concept.name,
        conceptCode: concept.code.standardCode.code,
        kind: "concept",
        status: entry && !entry.anyUnresolved ? "resolved" : "draft",
        itemOids: entry?.oids ?? [],
      });
    }
    for (const surrogate of resolved.surrogates) {
      const entry = itemsByUsdmId.get(surrogate.id);
      statuses.push({
        usdmId: surrogate.id,
        name: surrogate.name,
        kind: "surrogate",
        status: entry && !entry.anyUnresolved ? "resolved" : "draft",
        itemOids: entry?.oids ?? [],
      });
    }
    return statuses;
  };

  const matrix = soaMatrix(design);
  const unresolvedCount = candidate.metaDataVersion.itemDefs.filter(isUnresolvedItem).length;

  return {
    encounters: matrix.encounters.map((encounter) => {
      const timing = encounter.scheduledAtId
        ? timingById(design, encounter.scheduledAtId)
        : undefined;
      return {
        usdmId: encounter.id,
        label: displayLabel(encounter),
        ...(timing ? { timingLabel: timing.valueLabel } : {}),
        ...(timing?.windowLabel ? { windowLabel: timing.windowLabel } : {}),
      };
    }),
    rows: matrix.rows.flatMap((row) => {
      if (row.children.length > 0) {
        return [
          {
            usdmId: row.activity.id,
            label: displayLabel(row.activity),
            isGroupHeading: true,
            encounterIds: row.encounterIds,
            concepts: [],
          },
          ...row.children.map((child) => ({
            usdmId: child.id,
            label: displayLabel(child),
            isGroupHeading: false,
            encounterIds: row.encounterIds,
            concepts: conceptStatuses(child.id),
          })),
        ];
      }
      return [
        {
          usdmId: row.activity.id,
          label: displayLabel(row.activity),
          isGroupHeading: false,
          encounterIds: row.encounterIds,
          concepts: conceptStatuses(row.activity.id),
        },
      ];
    }),
    warnings,
    unresolvedCount,
  };
}

export interface DraftResolution {
  itemOid: string;
  name?: string | undefined;
  question?: string | undefined;
  dataType?: string | undefined;
  length?: number | null | undefined;
  mandatory?: boolean | undefined;
  codeListTerms?: { codedValue: string; decode?: string | undefined }[] | undefined;
}

export type CompilationUpdateResult =
  | { ok: true; unresolvedCount: number }
  | { ok: false; error: string };

/**
 * Complete draft items in the compilation candidate: the designer supplies
 * the concrete definition and the edc:Unresolved flag clears, moving the
 * candidate toward publishable. Provenance attributes are kept.
 */
export async function resolveDraftItems(
  db: Db,
  input: {
    studyId: string;
    protocolVersionId: string;
    resolutions: DraftResolution[];
    actorId: string;
  },
): Promise<CompilationUpdateResult> {
  return db.transaction(async (tx) => {
    const [compilation] = await tx
      .select()
      .from(protocolCompilations)
      .where(eq(protocolCompilations.protocolVersionId, input.protocolVersionId))
      .limit(1);
    if (!compilation) return { ok: false, error: "compilation not found" };
    if (compilation.status !== "in_review") {
      return { ok: false, error: `compilation is ${compilation.status}, not in_review` };
    }

    const candidate = compilation.candidate as unknown as StudyBuildDefinition;
    const mdv: MetaDataVersion = candidate.metaDataVersion;

    for (const resolution of input.resolutions) {
      const item = mdv.itemDefs.find((i) => i.oid === resolution.itemOid);
      if (!item) return { ok: false, error: `item "${resolution.itemOid}" not found` };
      if (!isUnresolvedItem(item)) {
        return { ok: false, error: `item "${resolution.itemOid}" is not an unresolved draft` };
      }

      if (resolution.name !== undefined) item.name = resolution.name;
      if (resolution.question !== undefined) {
        item.question = withDisplayText(item.question, resolution.question);
      }
      if (resolution.dataType !== undefined) item.dataType = resolution.dataType;
      if (resolution.length !== undefined) {
        if (resolution.length === null) item.length = undefined;
        else item.length = resolution.length;
      }
      if (resolution.codeListTerms !== undefined && resolution.codeListTerms.length > 0) {
        const codeListOid = `CL.${item.oid.replace(/^IT\./, "")}`;
        mdv.codeLists = mdv.codeLists.filter((cl) => cl.oid !== codeListOid);
        mdv.codeLists.push({
          oid: codeListOid,
          name: item.name,
          dataType: item.dataType === "integer" || item.dataType === "float" ? "integer" : "text",
          items: resolution.codeListTerms.map((t) => ({
            codedValue: t.codedValue,
            ...(t.decode ? { decode: [{ text: t.decode }] } : {}),
          })),
        });
        item.codeListRef = { codeListOid };
      }
      if (resolution.mandatory !== undefined) {
        for (const group of mdv.itemGroupDefs) {
          group.itemRefs = group.itemRefs.map((ref) =>
            ref.itemOid === item.oid
              ? { ...ref, mandatory: resolution.mandatory ? "Yes" : "No" }
              : ref,
          );
        }
      }

      if (item.extra) {
        delete item.extra[PROTOCOL_EXT_ATTRS.unresolved];
      }
    }

    const unresolvedCount = mdv.itemDefs.filter(isUnresolvedItem).length;
    await tx
      .update(protocolCompilations)
      .set({
        candidate,
        unresolvedCount,
        updatedBy: input.actorId,
        updatedAt: new Date(),
      })
      .where(eq(protocolCompilations.id, compilation.id));

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "protocol.compilation_updated",
      entityType: "protocol_compilation",
      entityId: compilation.id,
      newValue: {
        resolvedItemOids: input.resolutions.map((r) => r.itemOid),
        unresolvedCount,
      },
    });

    return { ok: true, unresolvedCount };
  });
}

export type PublishResult =
  | { ok: true; metadataVersionId: string; buildVersion: number }
  | { ok: false; error: string; issues?: unknown };

/**
 * Publish the compilation candidate as the study's next build version via
 * importStudyBuild — the publish gate (edc:Unresolved is a validation error)
 * runs inside it, and the traceability rows land relationally.
 */
export async function publishCompilation(
  db: Db,
  input: { studyId: string; protocolVersionId: string; actorId: string },
): Promise<PublishResult> {
  const [compilation] = await db
    .select()
    .from(protocolCompilations)
    .where(eq(protocolCompilations.protocolVersionId, input.protocolVersionId))
    .limit(1);
  if (!compilation) return { ok: false, error: "compilation not found" };
  if (compilation.status !== "in_review") {
    return { ok: false, error: `compilation is ${compilation.status}, not in_review` };
  }
  if (compilation.unresolvedCount > 0) {
    return {
      ok: false,
      error: `${compilation.unresolvedCount} unresolved draft item(s) must be completed before publish`,
    };
  }

  const [protocolRow] = await db
    .select({ version: protocolVersions.version })
    .from(protocolVersions)
    .where(
      and(
        eq(protocolVersions.id, input.protocolVersionId),
        eq(protocolVersions.studyId, input.studyId),
      ),
    )
    .limit(1);
  if (!protocolRow) return { ok: false, error: "protocol version not found" };

  const candidate = compilation.candidate as unknown as StudyBuildDefinition;
  const content = JSON.stringify({
    fileOid: `${candidate.study.oid}.protocol.v${protocolRow.version}`,
    fileType: "Snapshot",
    odmVersion: "2.0",
    creationDateTime: new Date().toISOString(),
    granularity: "Metadata",
    sourceSystem: "edc-core protocol compiler",
    study: {
      oid: candidate.study.oid,
      studyName: candidate.study.studyName,
      ...(candidate.study.protocolName !== undefined
        ? { protocolName: candidate.study.protocolName }
        : {}),
      metaDataVersions: [candidate.metaDataVersion],
    },
  });

  const imported = await importStudyBuild(db, {
    studyId: input.studyId,
    content,
    actorId: input.actorId,
    note: `Published from protocol v${protocolRow.version}`,
  });
  if (!imported.ok) {
    return { ok: false, error: "build validation failed", issues: imported.issues };
  }

  const traceRows = compilation.traceability as unknown as TraceRow[];
  await db.transaction(async (tx) => {
    if (traceRows.length > 0) {
      await tx.insert(protocolTraceability).values(
        traceRows.map((row) => ({
          metadataVersionId: imported.id,
          protocolVersionId: input.protocolVersionId,
          odmOid: row.odmOid,
          odmType: row.odmType,
          usdmId: row.usdmId,
          usdmInstanceType: row.usdmInstanceType,
          relation: row.relation,
        })),
      );
    }
    await tx
      .update(protocolCompilations)
      .set({
        status: "published",
        publishedMetadataVersionId: imported.id,
        updatedBy: input.actorId,
        updatedAt: new Date(),
      })
      .where(eq(protocolCompilations.id, compilation.id));
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "protocol.published",
      entityType: "protocol_compilation",
      entityId: compilation.id,
      newValue: {
        metadataVersionId: imported.id,
        buildVersion: imported.version,
        traceabilityRows: traceRows.length,
      },
    });
  });

  return { ok: true, metadataVersionId: imported.id, buildVersion: imported.version };
}
