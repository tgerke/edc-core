/**
 * edc-core protocol-provenance vendor extensions (edc: namespace, ADR-0009
 * pattern). Stored in `extra` bags under their XML attribute keys ("@_edc:*")
 * so they round-trip both serializations unchanged. Written by the protocol
 * compiler in @edc-core/usdm; this module only names the keys and reads them,
 * keeping the ODM package protocol-format-agnostic.
 */

export const PROTOCOL_EXT_ATTRS = {
  /** ItemDef: "Yes" marks a draft item a designer must complete before publish. */
  unresolved: "@_edc:Unresolved",
  /** StudyEventDef: source encounter id in the protocol document. */
  usdmEncounterId: "@_edc:UsdmEncounterId",
  /** StudyEventDef: space-separated scheduled instance ids at this event. */
  usdmInstanceIds: "@_edc:UsdmInstanceIds",
  /** ItemGroupDef: source activity id in the protocol document. */
  usdmActivityId: "@_edc:UsdmActivityId",
  /** ItemDef: source biomedical concept (or surrogate) id. */
  usdmBiomedicalConceptId: "@_edc:UsdmBiomedicalConceptId",
  /** ItemDef: source biomedical concept property id. */
  usdmPropertyId: "@_edc:UsdmPropertyId",
  /** ItemDef: NCI c-code of the source concept. */
  conceptCode: "@_edc:ConceptCode",
  /** StudyEventDef: planned timing (ISO 8601) relative to its anchor. */
  timingValue: "@_edc:TimingValue",
  /** StudyEventDef: display label for the planned timing (e.g. "Day 29"). */
  timingLabel: "@_edc:TimingLabel",
  /** StudyEventDef: visit window below/above the planned timing (ISO 8601). */
  timingWindowLower: "@_edc:TimingWindowLower",
  timingWindowUpper: "@_edc:TimingWindowUpper",
  /** StudyEventDef: display label for the window (e.g. "±3 days"). */
  timingWindowLabel: "@_edc:TimingWindowLabel",
  /** MetaDataVersion: edc-core protocol_versions row this build derives from. */
  protocolVersionId: "@_edc:ProtocolVersionId",
  /** MetaDataVersion: usdmVersion of the source package. */
  usdmVersion: "@_edc:UsdmVersion",
  /** MetaDataVersion: source StudyVersion id in the protocol document. */
  usdmStudyVersionId: "@_edc:UsdmStudyVersionId",
} as const;

type HasExtra = { extra?: Record<string, unknown> | undefined };

export function protocolExt(def: HasExtra, key: string): string | undefined {
  const value = def.extra?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Draft items from unresolved protocol concepts; blocked from publishing. */
export function isUnresolvedItem(def: HasExtra): boolean {
  return protocolExt(def, PROTOCOL_EXT_ATTRS.unresolved) === "Yes";
}

/** True when this build was compiled from a protocol document. */
export function isProtocolDerived(def: HasExtra): boolean {
  return protocolExt(def, PROTOCOL_EXT_ATTRS.protocolVersionId) !== undefined;
}
