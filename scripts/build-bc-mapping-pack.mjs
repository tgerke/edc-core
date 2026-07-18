#!/usr/bin/env node
/**
 * Offline generator for packages/usdm/src/mapping/pack.json — the bundled
 * biomedical-concept → collection-item mapping pack used by the USDM→ODM
 * compiler. Never runs at app runtime.
 *
 * Inputs:
 *   --cosmos <dir>   Local checkout (or export download) of the open
 *                    cdisc-org/COSMoS dataset (MIT licensed). Reads
 *                    export/cdisc_crf_specializations_draft.csv.
 *   --sha <sha>      COSMoS commit sha to record as provenance.
 *   --cdashig <csv>  Optional local CDASHIG v2.3 CSV used only to cross-check
 *                    that emitted variable names exist in CDASH. This file is
 *                    CDISC-licensed and must NOT be committed to the repo;
 *                    only the boolean outcome of the check is recorded.
 *   --out <path>     Output path (default packages/usdm/src/mapping/pack.json).
 *
 * The emitted pack contains only structural metadata (NCI c-codes, variable
 * names, datatypes, codelist codes/terms) written against the standards —
 * never reproduced CDISC publication text.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const record = {};
    header.forEach((name, i) => {
      record[name] = cells[i] ?? "";
    });
    return record;
  });
}

const cosmosDir = arg("cosmos");
if (!cosmosDir) {
  console.error("usage: build-bc-mapping-pack.mjs --cosmos <dir> [--sha <sha>] [--cdashig <csv>]");
  process.exit(1);
}

const repoRoot = path.join(import.meta.dirname, "..");
const outPath = arg("out", path.join(repoRoot, "packages/usdm/src/mapping/pack.json"));
const config = JSON.parse(
  readFileSync(path.join(repoRoot, "scripts/bc-pack-concepts.json"), "utf8"),
);

const crfRows = parseCsv(
  readFileSync(path.join(cosmosDir, "export/cdisc_crf_specializations_draft.csv"), "utf8"),
);

const packageDates = new Set(crfRows.map((r) => r.package_date).filter(Boolean));

const concepts = {};
for (const target of config.concepts) {
  const groupRows = crfRows.filter(
    (r) => r.bc_id === target.code && r.crf_group_id === target.crfGroup,
  );
  if (groupRows.length === 0) {
    console.error(`no CRF specialization rows for ${target.code} group ${target.crfGroup}`);
    process.exit(1);
  }
  const shortName = groupRows[0].short_name;
  const items = groupRows
    .filter((r) => r.dec_id !== "")
    .map((r) => {
      const terms = r.value_list
        ? r.value_list
            .split(";")
            .map((v) => v.trim())
            .filter(Boolean)
            .map((codedValue) => ({ codedValue }))
        : [];
      return {
        variable: r.variable_name,
        decCode: r.dec_id,
        question: r.question_text || r.prompt || `${shortName}: ${r.variable_name}`,
        dataType: r.data_type || "text",
        ...(r.length ? { length: Math.trunc(Number(r.length)) } : {}),
        mandatory: r.mandatory_variable === "Y",
        ...(r.codelist ? { codeList: { nciCode: r.codelist, terms } } : {}),
        ...(r.sdtm_target_variable
          ? {
              sdtm: {
                domain: r.domain,
                variable: r.sdtm_target_variable.split(";")[0],
              },
            }
          : {}),
      };
    });
  concepts[target.code] = { shortName, crfGroup: target.crfGroup, items };
}

let cdashigChecked = false;
const cdashigPath = arg("cdashig");
if (cdashigPath) {
  const cdashRows = parseCsv(readFileSync(cdashigPath, "utf8"));
  const cdashVars = new Set(cdashRows.map((r) => r["CDASHIG Variable"]));
  // COSMoS emits measurement-specific names like SYSBP_VSORRES; CDASH defines
  // the generic root (VSORRES), so check the trailing root token too.
  let missing = 0;
  for (const [code, concept] of Object.entries(concepts)) {
    for (const item of concept.items) {
      const root = item.variable.includes("_") ? item.variable.split("_").pop() : item.variable;
      if (!cdashVars.has(item.variable) && !cdashVars.has(root)) {
        console.warn(`warning: ${code} ${item.variable} not found in CDASHIG variable list`);
        missing++;
      }
    }
  }
  cdashigChecked = missing === 0;
}

const pack = {
  packVersion: "1.0.0",
  sources: {
    cosmos: {
      repository: "https://github.com/cdisc-org/COSMoS",
      license: "MIT",
      ...(arg("sha") ? { sha: arg("sha") } : {}),
      packageDates: [...packageDates].sort(),
    },
    ...(cdashigPath ? { cdashigCrossChecked: cdashigChecked, cdashigVersion: "v2.3" } : {}),
  },
  concepts: Object.fromEntries(Object.entries(concepts).sort(([a], [b]) => a.localeCompare(b))),
};

writeFileSync(outPath, `${JSON.stringify(pack, null, 2)}\n`);
console.log(`wrote ${outPath}: ${Object.keys(concepts).length} concepts`);
console.log("run `pnpm lint:fix` to apply repo formatting to the regenerated pack");
