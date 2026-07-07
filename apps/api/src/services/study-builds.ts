import {
  detectOdmSerialization,
  isOdm13Xml,
  type MetaDataVersion,
  type OdmSerialization,
  odmFileSchema,
  parseOdm,
  serializeOdm,
  upconvertOdm13Xml,
  type ValidationIssue,
  validateMetaDataVersion,
} from "@edc-core/odm";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, studies, studyMetadataVersions } from "../db/schema/index.js";

/** What a studyMetadataVersions.definition jsonb column holds. */
export interface StudyBuildDefinition {
  study: { oid: string; studyName: string; protocolName?: string };
  metaDataVersion: MetaDataVersion;
}

export type ImportResult =
  | { ok: true; id: string; version: number; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Creates the next study build version from ODM content. The visual builder
 * (Phase 2 UI) writes through this same path — imports and point-and-click
 * builds are indistinguishable downstream (ADR-0003).
 */
export async function importStudyBuild(
  db: Db,
  input: { studyId: string; content: string; actorId: string; note?: string },
): Promise<ImportResult> {
  let definition: StudyBuildDefinition;
  let conversionWarnings: ValidationIssue[] = [];
  try {
    // Legacy ODM 1.3.x imports upconvert to the v2.0 model with warnings.
    let file: ReturnType<typeof parseOdm>;
    if (detectOdmSerialization(input.content) === "xml" && isOdm13Xml(input.content)) {
      const converted = upconvertOdm13Xml(input.content);
      file = odmFileSchema.parse(converted.file);
      conversionWarnings = converted.warnings;
    } else {
      file = parseOdm(input.content);
    }
    const mdv = file.study?.metaDataVersions[0];
    if (!file.study || !mdv) {
      return {
        ok: false,
        issues: [
          {
            severity: "error",
            path: "ODM",
            message: "document contains no Study/MetaDataVersion metadata",
          },
        ],
      };
    }
    definition = {
      study: {
        oid: file.study.oid,
        studyName: file.study.studyName,
        ...(file.study.protocolName !== undefined ? { protocolName: file.study.protocolName } : {}),
      },
      metaDataVersion: mdv,
    };
  } catch (err) {
    return {
      ok: false,
      issues: [{ severity: "error", path: "ODM", message: (err as Error).message }],
    };
  }

  const issues = validateMetaDataVersion(definition.metaDataVersion);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) return { ok: false, issues };

  const inserted = await db.transaction(async (tx) => {
    // Serialize concurrent imports for the same study.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`study-build:${input.studyId}`}, 0))`,
    );
    const [latest] = await tx
      .select({ version: studyMetadataVersions.version })
      .from(studyMetadataVersions)
      .where(eq(studyMetadataVersions.studyId, input.studyId))
      .orderBy(desc(studyMetadataVersions.version))
      .limit(1);

    const [row] = await tx
      .insert(studyMetadataVersions)
      .values({
        studyId: input.studyId,
        version: (latest?.version ?? 0) + 1,
        definition,
        note: input.note ?? null,
        createdBy: input.actorId,
      })
      .returning();
    if (!row) throw new Error("study metadata insert returned no row");

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "study_metadata.imported",
      entityType: "study_metadata_version",
      entityId: row.id,
      newValue: {
        version: row.version,
        metaDataVersionOid: definition.metaDataVersion.oid,
        note: input.note ?? null,
      },
    });
    return row;
  });

  return {
    ok: true,
    id: inserted.id,
    version: inserted.version,
    warnings: [...conversionWarnings, ...issues.filter((i) => i.severity === "warning")],
  };
}

export async function exportStudyBuild(
  db: Db,
  input: { studyId: string; version: number; serialization: OdmSerialization },
): Promise<string | null> {
  const [row] = await db
    .select({ definition: studyMetadataVersions.definition, studyOid: studies.oid })
    .from(studyMetadataVersions)
    .innerJoin(studies, eq(studies.id, studyMetadataVersions.studyId))
    .where(
      and(
        eq(studyMetadataVersions.studyId, input.studyId),
        eq(studyMetadataVersions.version, input.version),
      ),
    )
    .limit(1);
  if (!row) return null;

  const definition = row.definition as unknown as StudyBuildDefinition;
  return serializeOdm(
    {
      fileOid: `${row.studyOid}.v${input.version}`,
      fileType: "Snapshot",
      odmVersion: "2.0",
      creationDateTime: new Date().toISOString(),
      granularity: "Metadata",
      sourceSystem: "edc-core",
      study: {
        oid: definition.study.oid,
        studyName: definition.study.studyName,
        ...(definition.study.protocolName !== undefined
          ? { protocolName: definition.study.protocolName }
          : {}),
        metaDataVersions: [definition.metaDataVersion],
      },
    },
    input.serialization,
  );
}
