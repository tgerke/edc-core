import { z } from "zod";

/**
 * Typed model of the CDISC ODM v2.0 subset edc-core builds and captures
 * against. Field names mirror ODM attribute names (camelCased); `extra`
 * bags hold any parsed-but-unmodeled attributes/elements verbatim so that
 * imports never silently drop content (they round-trip unchanged).
 *
 * v2.0 structural notes (vs 1.3.x) this model relies on:
 * - there is no FormDef: a form is an ItemGroupDef with Type="Form", and
 *   ItemGroupDefs nest via ItemGroupRef
 * - StudyName/ProtocolName are attributes of Study, not GlobalVariables
 * - ItemData carries its value in a Value child element
 */

export const translatedTextSchema = z.object({
  lang: z.string().optional(),
  type: z.string().optional(),
  text: z.string(),
});
export type TranslatedText = z.infer<typeof translatedTextSchema>;

const extra = z.record(z.string(), z.unknown()).optional();

export const itemGroupRefSchema = z.object({
  itemGroupOid: z.string().min(1),
  mandatory: z.string().optional(),
  orderNumber: z.number().int().optional(),
  extra,
});
export type ItemGroupRef = z.infer<typeof itemGroupRefSchema>;

export const itemRefSchema = z.object({
  itemOid: z.string().min(1),
  mandatory: z.string().optional(),
  repeat: z.string().optional(),
  other: z.string().optional(),
  orderNumber: z.number().int().optional(),
  methodOid: z.string().optional(),
  collectionExceptionConditionOid: z.string().optional(),
  extra,
});
export type ItemRef = z.infer<typeof itemRefSchema>;

export const studyEventDefSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  repeating: z.string().optional(),
  type: z.string().optional(),
  description: z.array(translatedTextSchema).optional(),
  itemGroupRefs: z.array(itemGroupRefSchema).default([]),
  extra,
});
export type StudyEventDef = z.infer<typeof studyEventDefSchema>;

export const itemGroupDefSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  type: z.string().optional(),
  repeating: z.string().optional(),
  description: z.array(translatedTextSchema).optional(),
  itemRefs: z.array(itemRefSchema).default([]),
  itemGroupRefs: z.array(itemGroupRefSchema).default([]),
  extra,
});
export type ItemGroupDef = z.infer<typeof itemGroupDefSchema>;

export const codeListRefSchema = z.object({
  codeListOid: z.string().min(1),
  extra,
});

export const itemDefSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  dataType: z.string().min(1),
  length: z.number().int().optional(),
  significantDigits: z.number().int().optional(),
  description: z.array(translatedTextSchema).optional(),
  question: z.array(translatedTextSchema).optional(),
  codeListRef: codeListRefSchema.optional(),
  // Vendor extension (edc:Blinded in XML): values of this item are masked
  // for roles without data.unblind and excluded from analytics snapshots.
  // Protocol metadata, so it versions with the build like everything else.
  blinded: z.boolean().optional(),
  // Vendor extension (edc:CodingDictionary in XML): values of this item are
  // verbatim terms to be coded against the named dictionary. Protocol
  // metadata, so it versions with the build like everything else.
  codingDictionary: z.enum(["MedDRA", "WHODrug"]).optional(),
  extra,
});
export type ItemDef = z.infer<typeof itemDefSchema>;

export const codeListItemSchema = z.object({
  codedValue: z.string(),
  decode: z.array(translatedTextSchema).optional(),
  extra,
});
export type CodeListItem = z.infer<typeof codeListItemSchema>;

export const codeListSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  dataType: z.string().min(1),
  items: z.array(codeListItemSchema).default([]),
  extra,
});
export type CodeList = z.infer<typeof codeListSchema>;

export const formalExpressionSchema = z.object({
  context: z.string().optional(),
  code: z.string(),
});

export const conditionDefSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  description: z.array(translatedTextSchema).optional(),
  formalExpressions: z.array(formalExpressionSchema).default([]),
  extra,
});
export type ConditionDef = z.infer<typeof conditionDefSchema>;

export const methodDefSchema = z.object({
  oid: z.string().min(1),
  name: z.string().min(1),
  type: z.string().optional(),
  description: z.array(translatedTextSchema).optional(),
  formalExpressions: z.array(formalExpressionSchema).default([]),
  extra,
});
export type MethodDef = z.infer<typeof methodDefSchema>;

export const metaDataVersionSchema = z.object({
  oid: z.string().min(1),
  name: z.string().optional(),
  description: z.array(translatedTextSchema).optional(),
  studyEventDefs: z.array(studyEventDefSchema).default([]),
  itemGroupDefs: z.array(itemGroupDefSchema).default([]),
  itemDefs: z.array(itemDefSchema).default([]),
  codeLists: z.array(codeListSchema).default([]),
  conditionDefs: z.array(conditionDefSchema).default([]),
  methodDefs: z.array(methodDefSchema).default([]),
  extra,
});
export type MetaDataVersion = z.infer<typeof metaDataVersionSchema>;

export const odmStudySchema = z.object({
  oid: z.string().min(1),
  studyName: z.string().min(1),
  protocolName: z.string().optional(),
  description: z.array(translatedTextSchema).optional(),
  metaDataVersions: z.array(metaDataVersionSchema).default([]),
  extra,
});
export type OdmStudy = z.infer<typeof odmStudySchema>;

export const odmFileSchema = z.object({
  fileOid: z.string().min(1),
  fileType: z.string(),
  odmVersion: z.literal("2.0"),
  creationDateTime: z.string(),
  granularity: z.string().optional(),
  sourceSystem: z.string().optional(),
  sourceSystemVersion: z.string().optional(),
  study: odmStudySchema.optional(),
  extra,
});
export type OdmFile = z.infer<typeof odmFileSchema>;
