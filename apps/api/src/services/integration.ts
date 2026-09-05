import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  formInstances,
  itemValueVersions,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
} from "../db/schema/index.js";
import { castable } from "./amendments.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * The PMO read surface (ADR-0017): visit and form-instance listings for a
 * metrics pipeline. Everything here is derived from capture — the visit date
 * is the current value of the build-designated edc:VisitDate item, resolved
 * per event instance under each form instance's own pinned build.
 */

export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationError";
  }
}

export interface VisitRow {
  subjectKey: string;
  eventOid: string;
  eventRepeatKey: number;
  visitDate: string | null;
  createdAt: Date;
}

export interface FormInstanceRow {
  subjectKey: string;
  eventOid: string;
  eventRepeatKey: number;
  formOid: string;
  repeatKey: number;
  status: string;
  firstEnteredAt: Date | null;
  createdAt: Date;
}

/** Designated visit-date item OIDs per metadata version. Blinded items are
 * excluded defensively — publish validation refuses that combination, so an
 * entry here means an unvalidated build slipped in; a blinded value must
 * still never cross this surface. */
async function designatedItemsByVersion(
  db: Db,
  versionIds: string[],
): Promise<Map<string, Set<string>>> {
  if (versionIds.length === 0) return new Map();
  const rows = await db
    .select({ id: studyMetadataVersions.id, definition: studyMetadataVersions.definition })
    .from(studyMetadataVersions)
    .where(inArray(studyMetadataVersions.id, versionIds));
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const definition = row.definition as unknown as StudyBuildDefinition;
    const oids = definition.metaDataVersion.itemDefs
      .filter((i) => i.visitDate && !i.blinded)
      .map((i) => i.oid);
    out.set(row.id, new Set(oids));
  }
  return out;
}

export async function listStudyVisits(db: Db, studyId: string): Promise<VisitRow[]> {
  const instances = await db
    .select({
      id: studyEventInstances.id,
      subjectKey: subjects.subjectKey,
      eventOid: studyEventInstances.eventOid,
      eventRepeatKey: studyEventInstances.repeatKey,
      createdAt: studyEventInstances.createdAt,
    })
    .from(studyEventInstances)
    .innerJoin(subjects, eq(studyEventInstances.subjectId, subjects.id))
    .where(eq(subjects.studyId, studyId))
    .orderBy(
      asc(subjects.subjectKey),
      asc(studyEventInstances.eventOid),
      asc(studyEventInstances.repeatKey),
    );
  if (instances.length === 0) return [];

  // Every current value on the study's form instances, tagged with the
  // instance's own pinned build — the designation that applies to a value is
  // the one in the build the form was captured under.
  const values = await db.execute<{
    event_instance_id: string;
    metadata_version_id: string;
    item_oid: string;
    value: string | null;
  }>(sql`
    SELECT fi.study_event_instance_id AS event_instance_id,
           fi.metadata_version_id, ivc.item_oid, ivc.value
    FROM item_values_current ivc
    JOIN form_instances fi ON fi.id = ivc.form_instance_id
    JOIN study_event_instances sei ON sei.id = fi.study_event_instance_id
    JOIN subjects s ON s.id = sei.subject_id
    WHERE s.study_id = ${studyId}
  `);

  const designated = await designatedItemsByVersion(db, [
    ...new Set(values.map((v) => v.metadata_version_id)),
  ]);

  const datesByInstance = new Map<string, Set<string>>();
  for (const v of values) {
    if (v.value === null) continue;
    if (!designated.get(v.metadata_version_id)?.has(v.item_oid)) continue;
    const found = datesByInstance.get(v.event_instance_id) ?? new Set<string>();
    found.add(v.value);
    datesByInstance.set(v.event_instance_id, found);
  }

  return instances.map((inst) => {
    const found = datesByInstance.get(inst.id);
    const name = `subject ${inst.subjectKey} event ${inst.eventOid}[${inst.eventRepeatKey}]`;
    if (found && found.size > 1) {
      throw new IntegrationError(
        `${name}: designated visit-date items disagree (${[...found].sort().join(", ")})`,
      );
    }
    const value = found ? [...found][0] : undefined;
    if (value !== undefined && !castable(value, "date")) {
      throw new IntegrationError(
        `${name}: visit date value "${value}" is not an ISO date (yyyy-MM-dd)`,
      );
    }
    return {
      subjectKey: inst.subjectKey,
      eventOid: inst.eventOid,
      eventRepeatKey: inst.eventRepeatKey,
      visitDate: value ?? null,
      createdAt: inst.createdAt,
    };
  });
}

export async function listStudyFormInstances(db: Db, studyId: string): Promise<FormInstanceRow[]> {
  const firstEntry = db
    .select({
      formInstanceId: itemValueVersions.formInstanceId,
      firstEnteredAt: sql<Date>`MIN(${itemValueVersions.createdAt})`.as("first_entered_at"),
    })
    .from(itemValueVersions)
    .groupBy(itemValueVersions.formInstanceId)
    .as("first_entry");

  return db
    .select({
      subjectKey: subjects.subjectKey,
      eventOid: studyEventInstances.eventOid,
      eventRepeatKey: studyEventInstances.repeatKey,
      formOid: formInstances.formOid,
      repeatKey: formInstances.repeatKey,
      status: formInstances.status,
      firstEnteredAt: firstEntry.firstEnteredAt,
      createdAt: formInstances.createdAt,
    })
    .from(formInstances)
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .innerJoin(subjects, eq(studyEventInstances.subjectId, subjects.id))
    .leftJoin(firstEntry, eq(firstEntry.formInstanceId, formInstances.id))
    .where(eq(subjects.studyId, studyId))
    .orderBy(
      asc(subjects.subjectKey),
      asc(studyEventInstances.eventOid),
      asc(studyEventInstances.repeatKey),
      asc(formInstances.formOid),
      asc(formInstances.repeatKey),
    );
}
