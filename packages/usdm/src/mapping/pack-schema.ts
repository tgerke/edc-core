import { z } from "zod";

/**
 * Schema for the bundled biomedical-concept mapping pack (pack.json),
 * generated offline by scripts/build-bc-mapping-pack.mjs from the open
 * COSMoS dataset. The pack carries only structural metadata (NCI c-codes,
 * variable names, datatypes, codelist codes/terms) — never reproduced
 * CDISC publication text.
 */

export const packTermSchema = z.object({
  codedValue: z.string(),
  decode: z.string().optional(),
});
export type PackTerm = z.infer<typeof packTermSchema>;

export const packCodeListSchema = z.object({
  nciCode: z.string(),
  terms: z.array(packTermSchema),
});
export type PackCodeList = z.infer<typeof packCodeListSchema>;

export const packItemSchema = z.object({
  variable: z.string().min(1),
  // NCI c-code of the data element concept; the match key against USDM
  // BiomedicalConceptProperty.code.standardCode.code.
  decCode: z.string().min(1),
  question: z.string(),
  dataType: z.string().min(1),
  length: z.number().int().optional(),
  mandatory: z.boolean(),
  codeList: packCodeListSchema.optional(),
  sdtm: z
    .object({
      domain: z.string(),
      variable: z.string(),
    })
    .optional(),
});
export type PackItem = z.infer<typeof packItemSchema>;

export const packConceptSchema = z.object({
  shortName: z.string(),
  crfGroup: z.string(),
  items: z.array(packItemSchema),
});
export type PackConcept = z.infer<typeof packConceptSchema>;

export const mappingPackSchema = z.object({
  packVersion: z.string(),
  sources: z.object({
    cosmos: z.object({
      repository: z.string(),
      license: z.string(),
      sha: z.string().optional(),
      packageDates: z.array(z.string()),
    }),
    cdashigCrossChecked: z.boolean().optional(),
    cdashigVersion: z.string().optional(),
  }),
  concepts: z.record(z.string(), packConceptSchema),
});
export type MappingPack = z.infer<typeof mappingPackSchema>;
