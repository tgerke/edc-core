import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, dictionaries, dictionaryTerms, users } from "../db/schema/index.js";
import { CaptureError } from "./capture.js";
import { isUniqueViolation, parseCsv } from "./lab-imports.js";

/**
 * Dictionary loading. MedDRA and WHODrug are licensed products (MSSO / UMC);
 * edc-core ships none of their content and does not parse their native
 * distribution formats. Customers convert their licensed files once into the
 * normalized CSVs below — a flat join their distribution tools produce
 * trivially — and upload the result (or use the db:load-dictionary script).
 */

export type DictionaryType = "MedDRA" | "WHODrug";

/** One row per LLT, carrying its full primary-SOC hierarchy path. */
export const MEDDRA_COLUMNS = [
  "llt_code",
  "llt_term",
  "pt_code",
  "pt_term",
  "hlt_code",
  "hlt_term",
  "hlgt_code",
  "hlgt_term",
  "soc_code",
  "soc_term",
] as const;

/** One row per drug name; ATC columns may be empty per row. */
export const WHODRUG_COLUMNS = ["code", "name", "atc_code", "atc_text"] as const;

/**
 * The single normalization used everywhere terms are compared: dictionary
 * load, workbench search, and exact-match auto-coding.
 */
export function normalizeTerm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

const INSERT_CHUNK = 2000;

interface TermRow {
  code: string;
  term: string;
  normalizedTerm: string;
  ptCode: string | null;
  ptTerm: string | null;
  hltCode: string | null;
  hltTerm: string | null;
  hlgtCode: string | null;
  hlgtTerm: string | null;
  socCode: string | null;
  socTerm: string | null;
  atcCode: string | null;
  atcText: string | null;
}

function parseTerms(type: DictionaryType, content: string): TermRow[] {
  const expected: readonly string[] = type === "MedDRA" ? MEDDRA_COLUMNS : WHODRUG_COLUMNS;
  const { header, rows } = parseCsv(content);
  if (header.map((h) => h.trim()).join(",") !== expected.join(",")) {
    throw new CaptureError(
      "invalid",
      `${type} dictionary CSV must have exactly the header: ${expected.join(",")}`,
    );
  }

  const seenCodes = new Set<string>();
  const terms: TermRow[] = [];
  for (const row of rows) {
    const field = (i: number) => (row.fields[i] ?? "").trim();
    // Dictionaries must be trustworthy: any bad row fails the whole load.
    const requiredThrough = type === "MedDRA" ? expected.length : 2;
    for (let i = 0; i < requiredThrough; i++) {
      if (field(i) === "") {
        throw new CaptureError("invalid", `line ${row.line}: column "${expected[i]}" is empty`);
      }
    }
    const code = field(0);
    if (seenCodes.has(code)) {
      throw new CaptureError("invalid", `line ${row.line}: duplicate code "${code}"`);
    }
    seenCodes.add(code);

    const term = field(1);
    if (type === "MedDRA") {
      terms.push({
        code,
        term,
        normalizedTerm: normalizeTerm(term),
        ptCode: field(2),
        ptTerm: field(3),
        hltCode: field(4),
        hltTerm: field(5),
        hlgtCode: field(6),
        hlgtTerm: field(7),
        socCode: field(8),
        socTerm: field(9),
        atcCode: null,
        atcText: null,
      });
    } else {
      terms.push({
        code,
        term,
        normalizedTerm: normalizeTerm(term),
        ptCode: null,
        ptTerm: null,
        hltCode: null,
        hltTerm: null,
        hlgtCode: null,
        hlgtTerm: null,
        socCode: null,
        socTerm: null,
        atcCode: field(2) === "" ? null : field(2),
        atcText: field(3) === "" ? null : field(3),
      });
    }
  }
  if (terms.length === 0) {
    throw new CaptureError("invalid", "dictionary CSV has no term rows");
  }
  return terms;
}

export interface LoadDictionaryInput {
  type: DictionaryType;
  version: string;
  content: string;
  actorId: string;
}

/**
 * Validates and loads a dictionary in one transaction. Synchronous by
 * design: a rare, admin-only operation over at most a few hundred thousand
 * rows — chunked inserts keep statements bounded without needing the
 * background-run machinery.
 */
export async function loadDictionary(db: Db, input: LoadDictionaryInput) {
  const terms = parseTerms(input.type, input.content);

  try {
    return await db.transaction(async (tx) => {
      const [dictionary] = await tx
        .insert(dictionaries)
        .values({
          type: input.type,
          version: input.version,
          termsCount: terms.length,
          createdBy: input.actorId,
        })
        .returning();
      if (!dictionary) throw new Error("dictionary insert returned no row");

      for (let offset = 0; offset < terms.length; offset += INSERT_CHUNK) {
        const chunk = terms.slice(offset, offset + INSERT_CHUNK);
        await tx
          .insert(dictionaryTerms)
          .values(chunk.map((t) => ({ ...t, dictionaryId: dictionary.id })));
      }

      await tx.insert(auditEvents).values({
        actorId: input.actorId,
        studyId: null,
        action: "dictionary.created",
        entityType: "dictionary",
        entityId: dictionary.id,
        newValue: { type: input.type, version: input.version, termsCount: terms.length },
      });
      return dictionary;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CaptureError(
        "conflict",
        `a ${input.type} dictionary with version "${input.version}" already exists`,
      );
    }
    throw err;
  }
}

export async function listDictionaries(db: Db) {
  return db
    .select({
      id: dictionaries.id,
      type: dictionaries.type,
      version: dictionaries.version,
      termsCount: dictionaries.termsCount,
      createdAt: dictionaries.createdAt,
      createdBy: users.username,
    })
    .from(dictionaries)
    .innerJoin(users, eq(dictionaries.createdBy, users.id))
    .orderBy(desc(dictionaries.createdAt));
}
