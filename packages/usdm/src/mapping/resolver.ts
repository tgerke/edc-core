import type { UsdmBiomedicalConcept, UsdmBiomedicalConceptProperty } from "../model.js";
import packJson from "./pack.json" with { type: "json" };
import { type MappingPack, mappingPackSchema, type PackItem } from "./pack-schema.js";

/**
 * Resolve a protocol biomedical concept against the bundled mapping pack:
 * from "the protocol requires Systolic Blood Pressure" to the concrete
 * collection items (variables, datatypes, codelists) a build needs.
 *
 * The protocol's BC properties configure the resolution (USDM-IG §4.13):
 * a pack item is included when the BC carries a matching enabled property
 * (matched on the property's NCI c-code), and its mandatory flag follows
 * the property's isRequired. A BC with no properties takes the pack's
 * defaults. Surrogate and unmatched concepts stay unresolved and surface
 * as draft items for the designer to complete.
 */

export const bundledMappingPack: MappingPack = mappingPackSchema.parse(packJson);

export interface ResolvedTerm {
  codedValue: string;
  decode?: string;
  nciCode?: string;
}

export interface ResolvedBcItem {
  variable: string;
  decCode: string;
  question: string;
  /** ODM v2.0 datatype (pack datatypes are mapped, e.g. decimal → float). */
  dataType: string;
  length?: number;
  mandatory: boolean;
  codeList?: { name: string; nciCode?: string; terms: ResolvedTerm[] };
  sdtm?: { domain: string; variable: string };
}

export interface ResolvedBc {
  kind: "resolved";
  conceptCode: string;
  shortName: string;
  items: ResolvedBcItem[];
  /** Enabled BC properties with no pack item to carry them (review flags). */
  uncoveredProperties: { propertyId: string; name: string; code: string }[];
}

export interface UnresolvedBc {
  kind: "unresolved";
  reason: string;
}

export type BcResolution = ResolvedBc | UnresolvedBc;

const ODM_DATATYPES: Record<string, string> = {
  decimal: "float",
  integer: "integer",
  text: "text",
  string: "text",
  date: "date",
  datetime: "datetime",
  time: "time",
  boolean: "boolean",
};

function odmDataType(packDataType: string): string {
  return ODM_DATATYPES[packDataType] ?? "text";
}

function normalizeName(name: string): string {
  // Pack short names carry COSMoS group qualifiers, e.g. "(Denormalized)".
  return name
    .replace(/\s*\(.*\)\s*$/, "")
    .trim()
    .toLowerCase();
}

function findConcept(
  pack: MappingPack,
  bc: UsdmBiomedicalConcept,
): { code: string; shortName: string; items: PackItem[] } | undefined {
  const conceptCode = bc.code.standardCode.code;
  const direct = pack.concepts[conceptCode];
  if (direct) return { code: conceptCode, ...direct };

  const candidates = new Set([normalizeName(bc.name), ...bc.synonyms.map(normalizeName)]);
  for (const [code, concept] of Object.entries(pack.concepts)) {
    if (candidates.has(normalizeName(concept.shortName))) return { code, ...concept };
  }
  return undefined;
}

function itemCodeList(
  item: PackItem,
  property: UsdmBiomedicalConceptProperty | undefined,
): ResolvedBcItem["codeList"] {
  const enabledResponses = property?.responseCodes.filter((r) => r.isEnabled) ?? [];
  if (enabledResponses.length > 0) {
    // The protocol constrains the terminology; it wins over pack defaults.
    return {
      name: item.variable,
      ...(item.codeList ? { nciCode: item.codeList.nciCode } : {}),
      terms: enabledResponses.map((r) => ({
        codedValue: r.name,
        decode: r.code.decode,
        nciCode: r.code.code,
      })),
    };
  }
  if (item.codeList && item.codeList.terms.length > 0) {
    return {
      name: item.variable,
      nciCode: item.codeList.nciCode,
      terms: item.codeList.terms.map((t) => ({
        codedValue: t.codedValue,
        ...(t.decode ? { decode: t.decode } : {}),
      })),
    };
  }
  // A codelist reference without terms (extensible CT, no subset) renders as
  // free text rather than an empty picklist.
  return undefined;
}

function toResolvedItem(
  item: PackItem,
  property: UsdmBiomedicalConceptProperty | undefined,
): ResolvedBcItem {
  const codeList = itemCodeList(item, property);
  return {
    variable: item.variable,
    decCode: item.decCode,
    question: item.question,
    dataType: odmDataType(property?.datatype ?? item.dataType),
    ...(item.length !== undefined ? { length: item.length } : {}),
    mandatory: property ? property.isRequired : item.mandatory,
    ...(codeList ? { codeList } : {}),
    ...(item.sdtm ? { sdtm: item.sdtm } : {}),
  };
}

export function resolveBc(
  bc: UsdmBiomedicalConcept,
  pack: MappingPack = bundledMappingPack,
): BcResolution {
  const concept = findConcept(pack, bc);
  if (!concept) {
    return {
      kind: "unresolved",
      reason: `no mapping for concept "${bc.name}" (${bc.code.standardCode.code})`,
    };
  }

  const enabledProperties = bc.properties.filter((p) => p.isEnabled);
  if (enabledProperties.length === 0 && bc.properties.length === 0) {
    // Unconstrained BC: the pack's defaults are the collection spec.
    return {
      kind: "resolved",
      conceptCode: concept.code,
      shortName: concept.shortName,
      items: concept.items.map((item) => toResolvedItem(item, undefined)),
      uncoveredProperties: [],
    };
  }

  const items: ResolvedBcItem[] = [];
  const covered = new Set<string>();
  for (const item of concept.items) {
    const property = enabledProperties.find((p) => p.code.standardCode.code === item.decCode);
    if (!property) continue;
    covered.add(property.id);
    items.push(toResolvedItem(item, property));
  }

  const uncoveredProperties = enabledProperties
    .filter((p) => !covered.has(p.id))
    .map((p) => ({ propertyId: p.id, name: p.name, code: p.code.standardCode.code }));

  if (items.length === 0) {
    return {
      kind: "unresolved",
      reason: `mapping for "${bc.name}" covers none of the protocol's enabled properties`,
    };
  }

  return {
    kind: "resolved",
    conceptCode: concept.code,
    shortName: concept.shortName,
    items,
    uncoveredProperties,
  };
}
