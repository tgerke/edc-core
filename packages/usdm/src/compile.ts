import {
  type CodeList,
  generateOid,
  type ItemDef,
  type ItemGroupDef,
  type MetaDataVersion,
  PROTOCOL_EXT_ATTRS,
  type StudyEventDef,
} from "@edc-core/odm";
import type { MappingPack } from "./mapping/pack-schema.js";
import { type BcResolution, bundledMappingPack, resolveBc } from "./mapping/resolver.js";
import type {
  UsdmBiomedicalConcept,
  UsdmBiomedicalConceptSurrogate,
  UsdmWrapper,
} from "./model.js";
import {
  activitiesForEncounter,
  displayLabel,
  encountersInOrder,
  mainTimeline,
  primaryStudyDesign,
  scheduledActivityInstancesInOrder,
  studyVersion,
  timingById,
} from "./resolve.js";

/**
 * Compile a USDM protocol package into an ODM v2.0 study build — the
 * protocol-first path's bridge into everything downstream (capture, checks,
 * amendments, analytics), which consumes ODM only (ADR-0003).
 *
 * Structure: each encounter on the main timeline becomes a StudyEventDef;
 * each *scheduled* activity becomes a form referenced from every event where
 * it is scheduled (activity grouping via children is SoA presentation, not
 * form structure); each activity's biomedical concepts resolve through the
 * bundled mapping pack into shared ItemDefs and CodeLists. Surrogate and
 * unmatched concepts become draft items flagged edc:Unresolved, which
 * validateMetaDataVersion rejects — so a compilation only publishes once a
 * designer completes them.
 *
 * OIDs are deterministic functions of protocol names/codes (not USDM UUIDs,
 * which may churn between authoring-tool exports) so recompiling an amended
 * protocol diffs cleanly against the previous build.
 */

export interface CompileIssue {
  severity: "warning";
  path: string;
  message: string;
}

export interface TraceRow {
  odmOid: string;
  odmType: "event" | "form" | "item" | "codelist";
  usdmId: string;
  usdmInstanceType: string;
  relation: "derived_from" | "placeholder_for";
}

export interface UnresolvedDraftItem {
  itemOid: string;
  activityId: string;
  reason: string;
}

export interface CompileResult {
  definition: {
    study: { oid: string; studyName: string; protocolName?: string };
    metaDataVersion: MetaDataVersion;
  };
  traceability: TraceRow[];
  unresolved: UnresolvedDraftItem[];
  warnings: CompileIssue[];
}

export interface CompileOptions {
  /** protocol_versions row id recorded on the MetaDataVersion for provenance. */
  protocolVersionId?: string;
  pack?: MappingPack;
}

function oidSlug(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "NEW";
}

/** Preferred compact label for OID derivation: first synonym, else name. */
function bcLabel(bc: UsdmBiomedicalConcept): string {
  return bc.synonyms[0] ?? bc.name;
}

interface CompiledConcept {
  itemOids: string[];
}

export function usdmToBuild(wrapper: UsdmWrapper, options: CompileOptions = {}): CompileResult {
  const pack = options.pack ?? bundledMappingPack;
  const version = studyVersion(wrapper);
  if (!version) throw new Error("USDM package has no StudyVersion");
  const design = primaryStudyDesign(version);
  if (!design) throw new Error("USDM package has no StudyDesign");

  const warnings: CompileIssue[] = [];
  const traceability: TraceRow[] = [];
  const unresolved: UnresolvedDraftItem[] = [];

  const itemDefs: ItemDef[] = [];
  const codeLists: CodeList[] = [];
  const itemOidsTaken = new Set<string>();
  const codeListOidsTaken = new Set<string>();
  // ItemRef.mandatory follows the protocol's isRequired; drafts are never mandatory.
  const mandatoryByItemOid = new Map<string, boolean>();

  // --- Concepts → shared ItemDefs/CodeLists (each BC compiled once) -------
  const compiledConcepts = new Map<string, CompiledConcept>();
  const compiledSurrogates = new Map<string, CompiledConcept>();

  const addDraftItem = (init: {
    baseName: string;
    question: string;
    description?: string | undefined;
    dataType?: string | undefined;
    usdmId: string;
    usdmInstanceType: string;
    activityId: string;
    reason: string;
    extraAttrs?: Record<string, string>;
  }): string => {
    const oid = generateOid(itemOidsTaken, "IT", `DRAFT ${init.baseName}`);
    itemOidsTaken.add(oid);
    mandatoryByItemOid.set(oid, false);
    itemDefs.push({
      oid,
      name: oidSlug(init.baseName),
      dataType: init.dataType ?? "text",
      question: [{ text: init.question }],
      ...(init.description ? { description: [{ text: init.description }] } : {}),
      extra: {
        [PROTOCOL_EXT_ATTRS.unresolved]: "Yes",
        ...(init.extraAttrs ?? {}),
      },
    });
    traceability.push({
      odmOid: oid,
      odmType: "item",
      usdmId: init.usdmId,
      usdmInstanceType: init.usdmInstanceType,
      relation: "placeholder_for",
    });
    unresolved.push({ itemOid: oid, activityId: init.activityId, reason: init.reason });
    return oid;
  };

  const compileConcept = (bc: UsdmBiomedicalConcept, activityId: string): CompiledConcept => {
    const existing = compiledConcepts.get(bc.id);
    if (existing) return existing;

    const resolution: BcResolution = resolveBc(bc, pack);
    const compiled: CompiledConcept = { itemOids: [] };

    if (resolution.kind === "unresolved") {
      const oid = addDraftItem({
        baseName: bcLabel(bc),
        question: bc.name,
        description: `Unresolved biomedical concept (${bc.code.standardCode.code}): ${resolution.reason}`,
        usdmId: bc.id,
        usdmInstanceType: "BiomedicalConcept",
        activityId,
        reason: resolution.reason,
        extraAttrs: {
          [PROTOCOL_EXT_ATTRS.usdmBiomedicalConceptId]: bc.id,
          [PROTOCOL_EXT_ATTRS.conceptCode]: bc.code.standardCode.code,
        },
      });
      compiled.itemOids.push(oid);
      compiledConcepts.set(bc.id, compiled);
      return compiled;
    }

    for (const item of resolution.items) {
      const label = oidSlug(bcLabel(bc));
      const baseName = label === item.variable ? item.variable : `${label} ${item.variable}`;
      const oid = generateOid(itemOidsTaken, "IT", baseName);
      itemOidsTaken.add(oid);
      mandatoryByItemOid.set(oid, item.mandatory);

      let codeListOid: string | undefined;
      if (item.codeList) {
        codeListOid = generateOid(codeListOidsTaken, "CL", baseName);
        codeListOidsTaken.add(codeListOid);
        codeLists.push({
          oid: codeListOid,
          name: item.codeList.name,
          dataType: item.dataType === "integer" || item.dataType === "float" ? "integer" : "text",
          items: item.codeList.terms.map((term) => ({
            codedValue: term.codedValue,
            ...(term.decode ? { decode: [{ text: term.decode }] } : {}),
          })),
        });
        traceability.push({
          odmOid: codeListOid,
          odmType: "codelist",
          usdmId: item.propertyId ?? bc.id,
          usdmInstanceType: item.propertyId ? "BiomedicalConceptProperty" : "BiomedicalConcept",
          relation: "derived_from",
        });
      }

      itemDefs.push({
        oid,
        name: oidSlug(baseName),
        dataType: item.dataType,
        ...(item.length !== undefined ? { length: item.length } : {}),
        question: [{ text: item.question }],
        ...(codeListOid ? { codeListRef: { codeListOid } } : {}),
        extra: {
          [PROTOCOL_EXT_ATTRS.usdmBiomedicalConceptId]: bc.id,
          ...(item.propertyId ? { [PROTOCOL_EXT_ATTRS.usdmPropertyId]: item.propertyId } : {}),
          [PROTOCOL_EXT_ATTRS.conceptCode]: resolution.conceptCode,
        },
      });
      traceability.push({
        odmOid: oid,
        odmType: "item",
        usdmId: item.propertyId ?? bc.id,
        usdmInstanceType: item.propertyId ? "BiomedicalConceptProperty" : "BiomedicalConcept",
        relation: "derived_from",
      });
      compiled.itemOids.push(oid);
    }

    for (const property of resolution.uncoveredProperties) {
      const oid = addDraftItem({
        baseName: `${bcLabel(bc)} ${property.name}`,
        question: property.name,
        description: `Protocol requires property "${property.name}" (${property.code}) of ${bc.name}, which the mapping pack does not carry.`,
        dataType: undefined,
        usdmId: property.propertyId,
        usdmInstanceType: "BiomedicalConceptProperty",
        activityId,
        reason: `property "${property.name}" (${property.code}) has no mapping`,
        extraAttrs: {
          [PROTOCOL_EXT_ATTRS.usdmBiomedicalConceptId]: bc.id,
          [PROTOCOL_EXT_ATTRS.usdmPropertyId]: property.propertyId,
          [PROTOCOL_EXT_ATTRS.conceptCode]: property.code,
        },
      });
      compiled.itemOids.push(oid);
    }

    compiledConcepts.set(bc.id, compiled);
    return compiled;
  };

  const compileSurrogate = (
    surrogate: UsdmBiomedicalConceptSurrogate,
    activityId: string,
  ): CompiledConcept => {
    const existing = compiledSurrogates.get(surrogate.id);
    if (existing) return existing;
    const oid = addDraftItem({
      baseName: surrogate.name,
      question: displayLabel(surrogate),
      description:
        surrogate.description ??
        "Surrogate biomedical concept: the protocol names this assessment without a data definition.",
      usdmId: surrogate.id,
      usdmInstanceType: "BiomedicalConceptSurrogate",
      activityId,
      reason: `surrogate concept "${surrogate.name}" has no data definition`,
      extraAttrs: { [PROTOCOL_EXT_ATTRS.usdmBiomedicalConceptId]: surrogate.id },
    });
    const compiled = { itemOids: [oid] };
    compiledSurrogates.set(surrogate.id, compiled);
    return compiled;
  };

  // --- Scheduled activities → forms ---------------------------------------
  const timeline = mainTimeline(design);
  const scheduledActivityIds = new Set<string>();
  if (timeline) {
    for (const instance of scheduledActivityInstancesInOrder(timeline)) {
      for (const id of instance.activityIds) scheduledActivityIds.add(id);
    }
  }

  const conceptsById = new Map(version.biomedicalConcepts.map((bc) => [bc.id, bc]));
  const categoriesById = new Map(version.bcCategories.map((c) => [c.id, c]));
  const surrogatesById = new Map(version.bcSurrogates.map((s) => [s.id, s]));

  const itemGroupDefs: ItemGroupDef[] = [];
  const formOidsTaken = new Set<string>();
  const formOidByActivityId = new Map<string, string>();

  for (const activity of design.activities) {
    if (!scheduledActivityIds.has(activity.id)) continue;

    const formOid = generateOid(formOidsTaken, "FO", displayLabel(activity));
    formOidsTaken.add(formOid);
    formOidByActivityId.set(activity.id, formOid);

    const itemOids: string[] = [];
    const seenItemOids = new Set<string>();
    const pushItems = (compiled: CompiledConcept) => {
      for (const oid of compiled.itemOids) {
        if (seenItemOids.has(oid)) continue;
        seenItemOids.add(oid);
        itemOids.push(oid);
      }
    };
    for (const bcId of activity.biomedicalConceptIds) {
      const bc = conceptsById.get(bcId);
      if (bc) pushItems(compileConcept(bc, activity.id));
    }
    for (const categoryId of activity.bcCategoryIds) {
      for (const memberId of categoriesById.get(categoryId)?.memberIds ?? []) {
        const bc = conceptsById.get(memberId);
        if (bc) pushItems(compileConcept(bc, activity.id));
      }
    }
    for (const surrogateId of activity.bcSurrogateIds) {
      const surrogate = surrogatesById.get(surrogateId);
      if (surrogate) pushItems(compileSurrogate(surrogate, activity.id));
    }

    if (itemOids.length === 0) {
      warnings.push({
        severity: "warning",
        path: `Activity[${activity.id}]`,
        message: `activity "${activity.name}" specifies no data: its form is empty`,
      });
    }
    if (activity.timelineId) {
      warnings.push({
        severity: "warning",
        path: `Activity[${activity.id}]`,
        message: `sub-timeline "${activity.timelineId}" is not compiled; review its steps manually`,
      });
    }

    itemGroupDefs.push({
      oid: formOid,
      name: displayLabel(activity),
      type: "Form",
      ...(activity.description ? { description: [{ text: activity.description }] } : {}),
      itemRefs: itemOids.map((itemOid, index) => ({
        itemOid,
        orderNumber: index + 1,
        mandatory: mandatoryByItemOid.get(itemOid) ? "Yes" : "No",
      })),
      itemGroupRefs: [],
      extra: { [PROTOCOL_EXT_ATTRS.usdmActivityId]: activity.id },
    });
    traceability.push({
      odmOid: formOid,
      odmType: "form",
      usdmId: activity.id,
      usdmInstanceType: "Activity",
      relation: "derived_from",
    });
  }

  // --- Encounters → events -------------------------------------------------
  const studyEventDefs: StudyEventDef[] = [];
  const eventOidsTaken = new Set<string>();
  const instancesByEncounter = new Map<string, string[]>();
  if (timeline) {
    for (const instance of scheduledActivityInstancesInOrder(timeline)) {
      if (!instance.encounterId) continue;
      const list = instancesByEncounter.get(instance.encounterId) ?? [];
      list.push(instance.id);
      instancesByEncounter.set(instance.encounterId, list);
    }
  }

  for (const encounter of encountersInOrder(design)) {
    const eventOid = generateOid(eventOidsTaken, "SE", displayLabel(encounter));
    eventOidsTaken.add(eventOid);

    const timing = encounter.scheduledAtId
      ? timingById(design, encounter.scheduledAtId)
      : undefined;
    if (!timing) {
      warnings.push({
        severity: "warning",
        path: `Encounter[${encounter.id}]`,
        message: `encounter "${encounter.name}" has no resolvable planned timing`,
      });
    }

    const formOids: string[] = [];
    for (const activity of activitiesForEncounter(design, encounter.id)) {
      const formOid = formOidByActivityId.get(activity.id);
      if (formOid && !formOids.includes(formOid)) formOids.push(formOid);
    }

    studyEventDefs.push({
      oid: eventOid,
      name: displayLabel(encounter),
      type: "Scheduled",
      ...(encounter.description ? { description: [{ text: encounter.description }] } : {}),
      itemGroupRefs: formOids.map((itemGroupOid, index) => ({
        itemGroupOid,
        orderNumber: index + 1,
      })),
      extra: {
        [PROTOCOL_EXT_ATTRS.usdmEncounterId]: encounter.id,
        ...(instancesByEncounter.get(encounter.id)?.length
          ? {
              [PROTOCOL_EXT_ATTRS.usdmInstanceIds]: (
                instancesByEncounter.get(encounter.id) ?? []
              ).join(" "),
            }
          : {}),
        ...(timing
          ? {
              [PROTOCOL_EXT_ATTRS.timingValue]: timing.value,
              [PROTOCOL_EXT_ATTRS.timingLabel]: timing.valueLabel,
              ...(timing.windowLower
                ? { [PROTOCOL_EXT_ATTRS.timingWindowLower]: timing.windowLower }
                : {}),
              ...(timing.windowUpper
                ? { [PROTOCOL_EXT_ATTRS.timingWindowUpper]: timing.windowUpper }
                : {}),
              ...(timing.windowLabel
                ? { [PROTOCOL_EXT_ATTRS.timingWindowLabel]: timing.windowLabel }
                : {}),
            }
          : {}),
      },
    });
    traceability.push({
      odmOid: eventOid,
      odmType: "event",
      usdmId: encounter.id,
      usdmInstanceType: "Encounter",
      relation: "derived_from",
    });
  }

  // --- Decisions and unscheduled structures → manual follow-ups ------------
  if (timeline) {
    for (const instance of timeline.instances) {
      if (instance.instanceType !== "ScheduledDecisionInstance") continue;
      const conditions = instance.conditionAssignments.map((a) => a.condition).join("; ");
      warnings.push({
        severity: "warning",
        path: `ScheduledDecisionInstance[${instance.id}]`,
        message: `conditional flow "${instance.name}" is not compiled (${conditions}); model it with edit checks or manual workflow`,
      });
    }
  }

  const metaDataVersion: MetaDataVersion = {
    oid: `MDV.${oidSlug(version.versionIdentifier)}`,
    name: `${wrapper.study.name} protocol v${version.versionIdentifier}`,
    studyEventDefs,
    itemGroupDefs,
    itemDefs,
    codeLists,
    conditionDefs: [],
    methodDefs: [],
    extra: {
      [PROTOCOL_EXT_ATTRS.usdmVersion]: wrapper.usdmVersion,
      [PROTOCOL_EXT_ATTRS.usdmStudyVersionId]: version.id,
      ...(options.protocolVersionId
        ? { [PROTOCOL_EXT_ATTRS.protocolVersionId]: options.protocolVersionId }
        : {}),
    },
  };

  return {
    definition: {
      study: {
        oid: `ST.${oidSlug(wrapper.study.name)}`,
        studyName: wrapper.study.name,
        ...(version.studyIdentifiers[0]?.text
          ? { protocolName: version.studyIdentifiers[0].text }
          : {}),
      },
      metaDataVersion,
    },
    traceability,
    unresolved,
    warnings,
  };
}
