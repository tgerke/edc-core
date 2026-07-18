import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUsdm, studyVersion } from "../index.js";
import type { UsdmBiomedicalConcept } from "../model.js";
import { bundledMappingPack, resolveBc } from "./resolver.js";

const examples = path.join(fileURLToPath(import.meta.url), "../../../../../examples");
const wrapper = parseUsdm(readFileSync(path.join(examples, "demo-protocol-usdm.json"), "utf8"));
const version = studyVersion(wrapper);
if (!version) throw new Error("fixture has no study version");

function bc(id: string): UsdmBiomedicalConcept {
  const found = version?.biomedicalConcepts.find((b) => b.id === id);
  if (!found) throw new Error(`fixture has no BC ${id}`);
  return structuredClone(found);
}

describe("bundledMappingPack", () => {
  it("is schema-valid with recorded provenance and no CDISC text", () => {
    expect(bundledMappingPack.packVersion).toBe("1.0.0");
    expect(bundledMappingPack.sources.cosmos.license).toBe("MIT");
    expect(bundledMappingPack.sources.cosmos.sha).toBeTruthy();
    expect(Object.keys(bundledMappingPack.concepts).length).toBeGreaterThanOrEqual(8);
  });
});

describe("resolveBc with protocol-constrained properties", () => {
  it("resolves SysBP to the properties the protocol enables", () => {
    const resolution = resolveBc(bc("BC_SysBP"));
    if (resolution.kind !== "resolved") throw new Error(resolution.reason);
    expect(resolution.conceptCode).toBe("C25298");
    // Protocol enables result + unit only: date/position/location are omitted.
    expect(resolution.items.map((i) => i.variable)).toEqual(["VSORRES", "VSORRESU"]);
    expect(resolution.uncoveredProperties).toEqual([]);

    const result = resolution.items[0];
    expect(result?.mandatory).toBe(true);
    // Property datatype (decimal) wins over the pack's integer, mapped to ODM float.
    expect(result?.dataType).toBe("float");

    const unit = resolution.items[1];
    expect(unit?.mandatory).toBe(false);
    // The protocol's response codes constrain the terminology.
    expect(unit?.codeList?.terms).toEqual([
      { codedValue: "mmHg", decode: "Millimeter of Mercury", nciCode: "C49670" },
    ]);
  });

  it("resolves Sex with protocol response codes as the codelist", () => {
    const resolution = resolveBc(bc("BC_Sex"));
    if (resolution.kind !== "resolved") throw new Error(resolution.reason);
    expect(resolution.conceptCode).toBe("C28421");
    expect(resolution.items.map((i) => i.variable)).toEqual(["SEX"]);
    expect(resolution.items[0]?.codeList?.terms.map((t) => t.nciCode)).toEqual([
      "C20197",
      "C16576",
    ]);
  });

  it("skips disabled properties", () => {
    const sysBp = bc("BC_SysBP");
    const unit = sysBp.properties.find((p) => p.id === "BCProp_SysBP_Unit");
    if (!unit) throw new Error("unreachable");
    unit.isEnabled = false;
    const resolution = resolveBc(sysBp);
    if (resolution.kind !== "resolved") throw new Error(resolution.reason);
    expect(resolution.items.map((i) => i.variable)).toEqual(["VSORRES"]);
  });

  it("reports enabled properties the pack cannot carry", () => {
    const sysBp = bc("BC_SysBP");
    sysBp.properties.push({
      id: "BCProp_Custom",
      name: "Investigator Mood",
      isRequired: false,
      isEnabled: true,
      datatype: "string",
      responseCodes: [],
      code: {
        id: "AliasCode_Custom",
        standardCode: {
          id: "Code_Custom",
          code: "C000000",
          codeSystem: "ncit.nci.nih.gov",
          codeSystemVersion: "2025-04-01",
          decode: "Not a real concept",
          instanceType: "Code",
        },
        instanceType: "AliasCode",
      },
      instanceType: "BiomedicalConceptProperty",
    });
    const resolution = resolveBc(sysBp);
    if (resolution.kind !== "resolved") throw new Error(resolution.reason);
    expect(resolution.uncoveredProperties).toEqual([
      { propertyId: "BCProp_Custom", name: "Investigator Mood", code: "C000000" },
    ]);
  });
});

describe("resolveBc fallbacks", () => {
  it("takes pack defaults for a BC with no properties", () => {
    const heartRate = bc("BC_HeartRate");
    heartRate.properties = [];
    const resolution = resolveBc(heartRate);
    if (resolution.kind !== "resolved") throw new Error(resolution.reason);
    expect(resolution.items.map((i) => i.variable)).toContain("VSDAT");
    expect(resolution.items.map((i) => i.variable)).toContain("VSORRES");
    const position = resolution.items.find((i) => i.variable === "VSPOS");
    expect(position?.mandatory).toBe(false);
    expect(position?.codeList?.terms.length).toBeGreaterThan(0);
  });

  it("matches by name when the c-code is unknown", () => {
    const heartRate = bc("BC_HeartRate");
    heartRate.code.standardCode.code = "CUNKNOWN";
    const resolution = resolveBc(heartRate);
    if (resolution.kind !== "resolved") throw new Error(resolution.reason);
    expect(resolution.conceptCode).toBe("C49677");
  });

  it("is unresolved for a concept outside the pack", () => {
    const unknown = bc("BC_SysBP");
    unknown.name = "Cerebrospinal Fluid Pressure";
    unknown.synonyms = [];
    unknown.code.standardCode.code = "CUNKNOWN";
    const resolution = resolveBc(unknown);
    expect(resolution.kind).toBe("unresolved");
  });

  it("is unresolved when no enabled property is coverable", () => {
    const sysBp = bc("BC_SysBP");
    for (const property of sysBp.properties) {
      property.code.standardCode.code = "C000000";
    }
    const resolution = resolveBc(sysBp);
    expect(resolution.kind).toBe("unresolved");
  });
});
