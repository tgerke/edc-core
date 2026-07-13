import { displayText, type ResolvedGroup, type ResolvedItem, resolveGroup } from "@edc-core/odm";
import { asc, eq, inArray, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import type { Db } from "../db/client.js";
import {
  formInstances,
  queries,
  sites,
  studies,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
} from "../db/schema/index.js";
import { API_VERSION } from "../server.js";
import { BLINDED_PLACEHOLDER, listUnblindings } from "./blinding.js";
import { ExportError } from "./exports.js";
import { listFormSignatures } from "./signatures.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * Subject casebook: a human-readable PDF of everything captured for one
 * subject — forms with current values, per-occurrence repeating groups,
 * correction markers, queries, and the signature manifest. This is the
 * inspection/retention rendering (P11-06): data assembled here mirrors the
 * form read API, laid out for review without the running system.
 */

export interface CasebookItem {
  label: string;
  itemOid: string;
  value: string | null;
  /** Codelist decode for the stored coded value, when one applies. */
  decode: string | null;
  /** Latest version number; > 1 means the value was corrected. */
  version: number;
  reasonForChange: string | null;
}

export interface CasebookGroup {
  groupOid: string;
  name: string;
  /** Occurrence number for repeating groups; null for non-repeating. */
  occurrence: number | null;
  items: CasebookItem[];
}

export interface CasebookForm {
  formOid: string;
  name: string;
  status: string;
  buildVersion: number;
  groups: CasebookGroup[];
  queries: {
    origin: string;
    status: string;
    message: string;
    openedAt: Date;
  }[];
  signatures: {
    signerName: string;
    meaning: string;
    signedAt: Date;
    recordHash: string;
    invalidatedReason: string | null;
  }[];
}

export interface CasebookEvent {
  eventOid: string;
  name: string;
  repeatKey: number;
  forms: CasebookForm[];
}

export interface CasebookData {
  study: { oid: string; name: string };
  subject: { key: string; status: string; siteName: string };
  generatedAt: string;
  generator: { name: string; version: string };
  /** Documented break-the-blind events (E6(R3) Annex 1 §4.1.4). Not masked:
   * they record that the blind was broken, never a treatment value. */
  unblindings: {
    category: string;
    reason: string;
    actorName: string;
    occurredAt: Date;
  }[];
  events: CasebookEvent[];
}

type ValueRow = {
  item_group_oid: string;
  item_group_repeat_key: number;
  item_oid: string;
  value: string | null;
  version: number;
  reason_for_change: string | null;
};

function walkItems(group: ResolvedGroup): ResolvedItem[] {
  return group.children.filter((c): c is ResolvedItem => c.kind === "item");
}

function childGroups(group: ResolvedGroup): ResolvedGroup[] {
  return group.children.filter((c): c is ResolvedGroup => c.kind === "group");
}

function itemLabel(item: ResolvedItem): string {
  return displayText(item.def.question) ?? displayText(item.def.description) ?? item.def.name;
}

/** Flatten a resolved form into casebook groups, expanding repeat occurrences. */
function flattenForm(form: ResolvedGroup, values: ValueRow[], unblind: boolean): CasebookGroup[] {
  const byGroupItem = new Map<string, ValueRow>();
  const occurrencesByGroup = new Map<string, Set<number>>();
  for (const row of values) {
    byGroupItem.set(`${row.item_group_oid}:${row.item_group_repeat_key}:${row.item_oid}`, row);
    let keys = occurrencesByGroup.get(row.item_group_oid);
    if (!keys) {
      keys = new Set();
      occurrencesByGroup.set(row.item_group_oid, keys);
    }
    keys.add(row.item_group_repeat_key);
  }

  const groups: CasebookGroup[] = [];
  const emit = (group: ResolvedGroup) => {
    const isRepeating = group.def.repeating !== undefined && group.def.repeating !== "No";
    const stored = [...(occurrencesByGroup.get(group.def.oid) ?? [])].sort((a, b) => a - b);
    const occurrences = isRepeating ? (stored.length > 0 ? stored : [1]) : [1];
    const items = walkItems(group);
    if (items.length > 0) {
      for (const occurrence of occurrences) {
        groups.push({
          groupOid: group.def.oid,
          name: group.def.name,
          occurrence: isRepeating ? occurrence : null,
          items: items.map((item): CasebookItem => {
            const row = byGroupItem.get(`${group.def.oid}:${occurrence}:${item.def.oid}`);
            const masked = item.def.blinded === true && !unblind && row?.value != null;
            const decode = !masked && row?.value != null ? item.codeList?.items : undefined;
            const decoded = decode?.find((c) => c.codedValue === row?.value);
            return {
              label: itemLabel(item),
              itemOid: item.def.oid,
              value: masked ? BLINDED_PLACEHOLDER : (row?.value ?? null),
              decode: decoded ? (displayText(decoded.decode) ?? null) : null,
              version: row?.version ?? 0,
              reasonForChange: masked ? null : (row?.reason_for_change ?? null),
            };
          }),
        });
      }
    }
    for (const child of childGroups(group)) emit(child);
  };
  for (const child of childGroups(form)) emit(child);
  // Items directly on the form (uncommon but legal).
  if (walkItems(form).length > 0) emit(form);
  return groups;
}

export async function collectCasebookData(
  db: Db,
  input: { studyId: string; subjectId: string; unblind?: boolean },
): Promise<CasebookData> {
  const unblind = input.unblind ?? false;
  const [subject] = await db
    .select({
      id: subjects.id,
      key: subjects.subjectKey,
      status: subjects.status,
      studyId: subjects.studyId,
      siteName: sites.name,
    })
    .from(subjects)
    .innerJoin(sites, eq(subjects.siteId, sites.id))
    .where(eq(subjects.id, input.subjectId))
    .limit(1);
  if (!subject || subject.studyId !== input.studyId) {
    throw new ExportError("not_found", "subject not found in this study");
  }
  const [study] = await db.select().from(studies).where(eq(studies.id, input.studyId)).limit(1);
  if (!study) throw new ExportError("not_found", "study not found");

  const eventRows = await db
    .select()
    .from(studyEventInstances)
    .where(eq(studyEventInstances.subjectId, subject.id))
    .orderBy(asc(studyEventInstances.eventOid), asc(studyEventInstances.repeatKey));
  const formRows =
    eventRows.length > 0
      ? await db
          .select()
          .from(formInstances)
          .where(
            inArray(
              formInstances.studyEventInstanceId,
              eventRows.map((e) => e.id),
            ),
          )
          .orderBy(asc(formInstances.formOid), asc(formInstances.repeatKey))
      : [];

  // Each form renders against the build it was captured under.
  const buildIds = [...new Set(formRows.map((f) => f.metadataVersionId))];
  const builds =
    buildIds.length > 0
      ? await db
          .select()
          .from(studyMetadataVersions)
          .where(inArray(studyMetadataVersions.id, buildIds))
      : [];
  const buildById = new Map(
    builds.map((b) => [
      b.id,
      {
        version: b.version,
        mdv: (b.definition as unknown as StudyBuildDefinition).metaDataVersion,
      },
    ]),
  );

  // Order events/forms the way the latest involved build schedules them.
  const newestBuild = [...buildById.values()].sort((a, b) => b.version - a.version)[0]?.mdv;
  const orderOf = (list: { oid: string }[] | undefined, oid: string) => {
    const index = list?.findIndex((entry) => entry.oid === oid) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const eventOrder = (oid: string) => orderOf(newestBuild?.studyEventDefs, oid);
  eventRows.sort(
    (a, b) =>
      eventOrder(a.eventOid) - eventOrder(b.eventOid) ||
      a.eventOid.localeCompare(b.eventOid) ||
      a.repeatKey - b.repeatKey,
  );

  const events: CasebookEvent[] = [];
  for (const eventRow of eventRows) {
    const eventForms = formRows.filter((f) => f.studyEventInstanceId === eventRow.id);
    if (eventForms.length === 0) continue;

    const forms: CasebookForm[] = [];
    for (const formRow of eventForms) {
      const build = buildById.get(formRow.metadataVersionId);
      if (!build) continue;
      const resolved = resolveGroup(build.mdv, formRow.formOid);
      if (!resolved) continue;

      const valueRows = await db.execute<ValueRow>(
        sql`SELECT item_group_oid, item_group_repeat_key, item_oid, value, version, reason_for_change
            FROM item_values_current
            WHERE form_instance_id = ${formRow.id}`,
      );

      const formQueries = await db
        .select()
        .from(queries)
        .where(eq(queries.formInstanceId, formRow.id))
        .orderBy(asc(queries.createdAt));

      const formSignatures = await listFormSignatures(db, formRow.id);

      forms.push({
        formOid: formRow.formOid,
        name: resolved.def.name,
        status: formRow.status,
        buildVersion: build.version,
        groups: flattenForm(resolved, [...valueRows], unblind),
        queries: formQueries.map((q) => ({
          origin: q.origin,
          status: q.status,
          message: q.checkOid
            ? `Edit check ${q.checkOid}${q.itemGroupRepeatKey != null ? ` (occurrence ${q.itemGroupRepeatKey})` : ""}`
            : `Manual query${q.itemOid ? ` on ${q.itemOid}` : ""}`,
          openedAt: q.createdAt,
        })),
        signatures: formSignatures.map((s) => ({
          signerName: s.signerName,
          meaning: s.meaning,
          signedAt: s.signedAt,
          recordHash: s.recordHash,
          invalidatedReason: s.invalidatedAt ? (s.invalidatedReason ?? "invalidated") : null,
        })),
      });
    }

    const eventDef = newestBuild?.studyEventDefs.find((e) => e.oid === eventRow.eventOid);
    events.push({
      eventOid: eventRow.eventOid,
      name: eventDef?.name ?? eventRow.eventOid,
      repeatKey: eventRow.repeatKey,
      forms,
    });
  }

  const unblindings = await listUnblindings(db, input.studyId, subject.id);

  return {
    study: { oid: study.oid, name: study.name },
    subject: { key: subject.key, status: subject.status, siteName: subject.siteName },
    generatedAt: new Date().toISOString(),
    generator: { name: "edc-core", version: API_VERSION },
    unblindings: unblindings.map((u) => ({
      category: u.category,
      reason: u.reason,
      actorName: u.actorName,
      occurredAt: u.createdAt,
    })),
    events,
  };
}

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

const PAGE_MARGIN = 54;
const ZINC = { heading: "#18181b", body: "#27272a", muted: "#71717a", line: "#e4e4e7" };

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export function renderCasebookPdf(data: CasebookData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN + 14, left: PAGE_MARGIN, right: PAGE_MARGIN },
    bufferPages: true,
    info: {
      Title: `Subject casebook ${data.subject.key} — ${data.study.name}`,
      Author: `${data.generator.name} ${data.generator.version}`,
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk as Buffer));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const width = doc.page.width - PAGE_MARGIN * 2;
  const ensureRoom = (needed: number) => {
    if (doc.y + needed > doc.page.height - PAGE_MARGIN - 20) doc.addPage();
  };

  // Title block.
  doc.font("Helvetica-Bold").fontSize(20).fillColor(ZINC.heading).text("Subject casebook");
  doc.moveDown(0.3);
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor(ZINC.body)
    .text(`${data.study.name} (${data.study.oid})`)
    .text(`Subject ${data.subject.key} · ${data.subject.siteName} · ${data.subject.status}`)
    .fillColor(ZINC.muted)
    .fontSize(9)
    .text(`Generated ${data.generatedAt} by ${data.generator.name} ${data.generator.version}`)
    .text(
      "Current values as of generation time; corrected values are marked with their version. " +
        "The complete change history is in the study audit trail.",
    );
  doc.moveDown(1);

  if (data.unblindings.length > 0) {
    ensureRoom(50);
    doc.font("Helvetica-Bold").fontSize(12).fillColor(ZINC.heading).text("Unblinding events");
    doc.moveDown(0.2);
    for (const event of data.unblindings) {
      ensureRoom(16);
      doc
        .font("Helvetica")
        .fontSize(9.5)
        .fillColor(ZINC.body)
        .text(
          `${event.occurredAt.toISOString()} · ${event.category} · ${event.actorName} · ${event.reason}`,
          { indent: 8 },
        );
    }
    doc.moveDown(1);
  }

  if (data.events.length === 0) {
    doc.font("Helvetica").fontSize(11).fillColor(ZINC.muted).text("No data recorded.");
  }

  for (const event of data.events) {
    ensureRoom(60);
    doc.moveDown(0.5);
    doc
      .font("Helvetica-Bold")
      .fontSize(14)
      .fillColor(ZINC.heading)
      .text(`${event.name}${event.repeatKey > 1 ? ` (occurrence ${event.repeatKey})` : ""}`);
    doc
      .moveTo(PAGE_MARGIN, doc.y + 2)
      .lineTo(PAGE_MARGIN + width, doc.y + 2)
      .strokeColor(ZINC.line)
      .stroke();
    doc.moveDown(0.5);

    for (const form of event.forms) {
      ensureRoom(70);
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .fillColor(ZINC.heading)
        .text(`${form.name}  `, { continued: true })
        .font("Helvetica")
        .fontSize(9)
        .fillColor(ZINC.muted)
        .text(`${statusLabel(form.status)} · build v${form.buildVersion} · ${form.formOid}`);
      doc.moveDown(0.3);

      for (const group of form.groups) {
        ensureRoom(50);
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor(ZINC.body)
          .text(
            group.occurrence !== null
              ? `${group.name} — occurrence ${group.occurrence}`
              : group.name,
            { indent: 8 },
          );
        doc.moveDown(0.15);

        for (const item of group.items) {
          ensureRoom(26);
          const y = doc.y;
          doc
            .font("Helvetica")
            .fontSize(9.5)
            .fillColor(ZINC.body)
            .text(item.label, PAGE_MARGIN + 16, y, { width: width * 0.52 - 16 });
          const labelBottom = doc.y;

          const rendered =
            item.value === null ? "—" : item.decode ? `${item.decode} (${item.value})` : item.value;
          const correction =
            item.version > 1
              ? `  [v${item.version}${item.reasonForChange ? `: ${item.reasonForChange}` : ""}]`
              : "";
          doc
            .font("Helvetica-Bold")
            .fontSize(9.5)
            .fillColor(item.value === null ? ZINC.muted : ZINC.heading)
            .text(rendered, PAGE_MARGIN + width * 0.54, y, {
              width: width * 0.46,
              continued: correction !== "",
            });
          if (correction) {
            doc.font("Helvetica-Oblique").fillColor(ZINC.muted).text(correction);
          }
          doc.y = Math.max(labelBottom, doc.y);
          doc.x = PAGE_MARGIN;
          doc.moveDown(0.25);
        }
        doc.moveDown(0.3);
      }

      if (form.queries.length > 0) {
        ensureRoom(40);
        doc.font("Helvetica-Bold").fontSize(10).fillColor(ZINC.body).text("Queries", { indent: 8 });
        for (const query of form.queries) {
          ensureRoom(16);
          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor(ZINC.muted)
            .text(
              `${query.status} · ${query.origin} · ${query.message} · opened ${query.openedAt.toISOString()}`,
              { indent: 16 },
            );
        }
        doc.moveDown(0.3);
      }

      if (form.signatures.length > 0) {
        ensureRoom(40);
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor(ZINC.body)
          .text("Signatures", { indent: 8 });
        for (const signature of form.signatures) {
          ensureRoom(24);
          doc
            .font("Helvetica")
            .fontSize(9)
            .fillColor(signature.invalidatedReason ? ZINC.muted : ZINC.body)
            .text(
              `${signature.signerName} · ${signature.meaning} · ${signature.signedAt.toISOString()}` +
                (signature.invalidatedReason
                  ? ` · INVALIDATED: ${signature.invalidatedReason}`
                  : " · valid"),
              { indent: 16 },
            )
            .fillColor(ZINC.muted)
            .text(`record hash ${signature.recordHash}`, { indent: 16 });
        }
        doc.moveDown(0.3);
      }
      doc.moveDown(0.4);
    }
  }

  // Page footers. Zero the bottom margin first: writing inside it would
  // otherwise trigger pdfkit's automatic page break and append a blank page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(ZINC.muted)
      .text(
        `${data.study.oid} · Subject ${data.subject.key} · page ${i + 1} of ${range.count}`,
        PAGE_MARGIN,
        doc.page.height - PAGE_MARGIN + 8,
        { width, align: "center", lineBreak: false },
      );
  }

  doc.end();
  return done;
}

export interface CasebookResult {
  filename: string;
  body: Buffer;
  subjectKey: string;
}

export async function generateSubjectCasebook(
  db: Db,
  input: { studyId: string; subjectId: string; unblind?: boolean },
): Promise<CasebookResult> {
  const data = await collectCasebookData(db, input);
  const body = await renderCasebookPdf(data);
  return {
    filename: `${data.study.oid}-subject-${data.subject.key}-casebook.pdf`,
    body,
    subjectKey: data.subject.key,
  };
}
