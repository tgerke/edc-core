import { desc, eq } from "drizzle-orm";
import { ZipFile } from "yazl";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  formInstances,
  signatures,
  snapshots,
  studies,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
  users,
} from "../db/schema/index.js";
import { API_VERSION } from "../server.js";
import { generateSubjectCasebook } from "./casebook.js";
import { ExportError, exportSnapshotTable } from "./exports.js";
import type { SnapshotManifest } from "./snapshots.js";
import { exportStudyBuild } from "./study-builds.js";

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header.join(","), ...rows.map((row) => row.map(csvField).join(","))].join("\n");
}

async function auditCsv(db: Db, studyId: string): Promise<string> {
  const rows = await db
    .select({
      occurredAt: auditEvents.occurredAt,
      actor: users.username,
      actorName: users.fullName,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      oldValue: auditEvents.oldValue,
      newValue: auditEvents.newValue,
      reason: auditEvents.reason,
    })
    .from(auditEvents)
    .innerJoin(users, eq(auditEvents.actorId, users.id))
    .where(eq(auditEvents.studyId, studyId))
    .orderBy(auditEvents.occurredAt, auditEvents.id);
  return toCsv(
    [
      "occurred_at",
      "actor",
      "actor_name",
      "action",
      "entity_type",
      "entity_id",
      "old_value",
      "new_value",
      "reason",
    ],
    rows.map((r) => [
      r.occurredAt.toISOString(),
      r.actor,
      r.actorName,
      r.action,
      r.entityType,
      r.entityId,
      r.oldValue,
      r.newValue,
      r.reason,
    ]),
  );
}

async function signatureManifest(db: Db, studyId: string) {
  return db
    .select({
      subjectKey: subjects.subjectKey,
      eventOid: studyEventInstances.eventOid,
      eventRepeatKey: studyEventInstances.repeatKey,
      formOid: formInstances.formOid,
      formRepeatKey: formInstances.repeatKey,
      signerUsername: users.username,
      signerName: users.fullName,
      meaning: signatures.meaning,
      recordHash: signatures.recordHash,
      signedAt: signatures.signedAt,
      invalidatedAt: signatures.invalidatedAt,
      invalidatedReason: signatures.invalidatedReason,
    })
    .from(signatures)
    .innerJoin(formInstances, eq(signatures.formInstanceId, formInstances.id))
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .innerJoin(subjects, eq(studyEventInstances.subjectId, subjects.id))
    .innerJoin(users, eq(signatures.signerId, users.id))
    .where(eq(subjects.studyId, studyId))
    .orderBy(subjects.subjectKey, signatures.signedAt);
}

export interface ArchiveResult {
  filename: string;
  body: Buffer;
  snapshotId: string;
  lakeVersion: string;
}

/**
 * The self-contained study archive (P11-06, E6-10): everything needed to
 * review the study without the running system, in open formats — ODM v2.0
 * metadata (every build version, XML and JSON), Dataset-JSON + CSV data
 * pinned to one snapshot, the complete audit trail, and the signature
 * manifest with record hashes.
 */
export async function buildStudyArchive(
  db: Db,
  input: { studyId: string; snapshotId?: string | undefined },
): Promise<ArchiveResult> {
  const [study] = await db.select().from(studies).where(eq(studies.id, input.studyId));
  if (!study) throw new ExportError("not_found", "study not found");

  let snapshot: typeof snapshots.$inferSelect | undefined;
  if (input.snapshotId) {
    [snapshot] = await db.select().from(snapshots).where(eq(snapshots.id, input.snapshotId));
    if (!snapshot || snapshot.studyId !== input.studyId) {
      throw new ExportError("not_found", "snapshot not found in this study");
    }
  } else {
    [snapshot] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.studyId, input.studyId))
      .orderBy(desc(snapshots.createdAt))
      .limit(1);
  }
  if (!snapshot || snapshot.status !== "published" || snapshot.lakeVersion === null) {
    throw new ExportError(
      "invalid",
      "study has no published snapshot — publish one before archiving",
    );
  }
  const manifest = snapshot.manifest as SnapshotManifest;
  const lakeVersion = String(snapshot.lakeVersion);

  const zip = new ZipFile();
  const contents: string[] = [];
  const add = (path: string, content: string | Buffer) => {
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), path);
    contents.push(path);
  };

  // Metadata: every build version, both serializations.
  const versions = await db
    .select({ version: studyMetadataVersions.version })
    .from(studyMetadataVersions)
    .where(eq(studyMetadataVersions.studyId, input.studyId))
    .orderBy(studyMetadataVersions.version);
  for (const { version } of versions) {
    for (const serialization of ["xml", "json"] as const) {
      const odm = await exportStudyBuild(db, { studyId: input.studyId, version, serialization });
      if (odm) add(`metadata/odm-v${version}.${serialization}`, odm);
    }
  }

  // Data: every snapshot table — datasets as Dataset-JSON + CSV, core as CSV.
  for (const table of manifest.tables) {
    if (table.kind === "dataset") {
      const dsj = await exportSnapshotTable(db, {
        snapshotId: snapshot.id,
        table: table.table,
        format: "dataset-json",
      });
      add(`data/${table.table}.dataset.json`, dsj.body);
    }
    const csv = await exportSnapshotTable(db, {
      snapshotId: snapshot.id,
      table: table.table,
      format: "csv",
    });
    add(`data/${table.table}.csv`, csv.body);
  }

  // Audit trail and signature manifest.
  add("audit/audit-trail.csv", await auditCsv(db, input.studyId));
  add(
    "signatures/signatures.json",
    JSON.stringify(await signatureManifest(db, input.studyId), null, 2),
  );

  // Human-readable casebook per subject (P11-06 retention rendering).
  const studySubjects = await db
    .select({ id: subjects.id, subjectKey: subjects.subjectKey })
    .from(subjects)
    .where(eq(subjects.studyId, input.studyId))
    .orderBy(subjects.subjectKey);
  for (const subject of studySubjects) {
    const casebook = await generateSubjectCasebook(db, {
      studyId: input.studyId,
      subjectId: subject.id,
    });
    add(`casebooks/${subject.subjectKey}.pdf`, casebook.body);
  }

  add(
    "MANIFEST.json",
    JSON.stringify(
      {
        archiveVersion: "1",
        generatedAt: new Date().toISOString(),
        generator: { name: "edc-core", version: API_VERSION },
        study: { oid: study.oid, name: study.name },
        snapshot: {
          id: snapshot.id,
          lakeVersion,
          publishedAt: snapshot.publishedAt,
          note: snapshot.note,
          metadataVersion: manifest.metadataVersion,
        },
        contents,
      },
      null,
      2,
    ),
  );

  zip.end();
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk as Buffer));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });

  return {
    filename: `${study.oid}-archive-snapshot-v${lakeVersion}.zip`,
    body,
    snapshotId: snapshot.id,
    lakeVersion,
  };
}
