import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formsForEvent,
  isProtocolDerived,
  isUnresolvedItem,
  PROTOCOL_EXT_ATTRS,
  resolveGroup,
  validateMetaDataVersion,
} from "@edc-core/odm";
import { describe, expect, it } from "vitest";
import { parseUsdm, usdmToBuild } from "./index.js";
import type { UsdmWrapper } from "./model.js";

const examples = path.join(fileURLToPath(import.meta.url), "../../../../examples");
const demoProtocol = readFileSync(path.join(examples, "demo-protocol-usdm.json"), "utf8");

function demo(): UsdmWrapper {
  return parseUsdm(demoProtocol);
}

describe("usdmToBuild on the demo protocol", () => {
  const result = usdmToBuild(demo(), { protocolVersionId: "pv-123" });
  const mdv = result.definition.metaDataVersion;

  it("derives the study header", () => {
    expect(result.definition.study).toEqual({
      oid: "ST.DEMO_PROT",
      studyName: "DEMO-PROT",
      protocolName: "DEMO-PROT",
    });
    expect(mdv.oid).toBe("MDV.1_0");
    expect(isProtocolDerived(mdv)).toBe(true);
    expect(mdv.extra?.[PROTOCOL_EXT_ATTRS.usdmVersion]).toBe("4.0.0");
  });

  it("compiles encounters to events in timeline order with timing extensions", () => {
    expect(mdv.studyEventDefs.map((e) => e.oid)).toEqual([
      "SE.SCREENING_VISIT",
      "SE.BASELINE_VISIT",
      "SE.WEEK_4_VISIT",
    ]);
    const week4 = mdv.studyEventDefs[2];
    expect(week4?.extra?.[PROTOCOL_EXT_ATTRS.usdmEncounterId]).toBe("Encounter_Week4");
    expect(week4?.extra?.[PROTOCOL_EXT_ATTRS.timingValue]).toBe("P28D");
    expect(week4?.extra?.[PROTOCOL_EXT_ATTRS.timingWindowLabel]).toBe("±3 days");
  });

  it("compiles scheduled activities to forms shared across events", () => {
    const forms = mdv.itemGroupDefs.filter((g) => g.type === "Form");
    expect(forms.map((f) => f.oid).sort()).toEqual([
      "FO.12_LEAD_ECG",
      "FO.ADVERSE_EVENTS",
      "FO.CONCOMITANT_MEDICATIONS",
      "FO.DEMOGRAPHICS",
      "FO.VITAL_SIGNS",
    ]);
    // Vital Signs is one shared def referenced from all three events.
    for (const eventOid of ["SE.SCREENING_VISIT", "SE.BASELINE_VISIT", "SE.WEEK_4_VISIT"]) {
      expect(formsForEvent(mdv, eventOid).map((f) => f.oid)).toContain("FO.VITAL_SIGNS");
    }
    // The grouping activity (Safety) is presentation-only: no form.
    expect(forms.some((f) => f.name === "Safety")).toBe(false);
  });

  it("resolves protocol-constrained BCs into items and codelists", () => {
    const vitals = resolveGroup(mdv, "FO.VITAL_SIGNS");
    const oids = vitals?.children.map((c) => (c.kind === "item" ? c.def.oid : c.def.oid));
    // Direct BC (Weight) first, then category members (SysBP, DiaBP, HR);
    // only protocol-enabled properties become items (Weight has result only).
    expect(oids).toEqual([
      "IT.WEIGHT_VSORRES",
      "IT.SYSBP_VSORRES",
      "IT.SYSBP_VSORRESU",
      "IT.DIABP_VSORRES",
      "IT.HR_VSORRES",
    ]);

    const sysBpUnit = vitals?.children.find(
      (c) => c.kind === "item" && c.def.oid === "IT.SYSBP_VSORRESU",
    );
    if (sysBpUnit?.kind !== "item") throw new Error("unreachable");
    expect(sysBpUnit.ref.mandatory).toBe("No");
    expect(sysBpUnit.codeList?.items.map((t) => t.codedValue)).toEqual(["mmHg"]);
    expect(sysBpUnit.def.extra?.[PROTOCOL_EXT_ATTRS.conceptCode]).toBe("C25298");

    const sex = resolveGroup(mdv, "FO.DEMOGRAPHICS")?.children[0];
    if (sex?.kind !== "item") throw new Error("unreachable");
    expect(sex.def.oid).toBe("IT.SEX");
    expect(sex.ref.mandatory).toBe("Yes");
    expect(sex.codeList?.items.map((t) => t.codedValue)).toEqual(["Male", "Female"]);
  });

  it("turns surrogate concepts into unresolved draft items", () => {
    expect(result.unresolved.map((u) => u.itemOid).sort()).toEqual([
      "IT.DRAFT_12_LEAD_ECG",
      "IT.DRAFT_ADVERSE_EVENTS",
      "IT.DRAFT_CONCOMITANT_MEDICATIONS",
    ]);
    const draft = mdv.itemDefs.find((i) => i.oid === "IT.DRAFT_ADVERSE_EVENTS");
    if (!draft) throw new Error("unreachable");
    expect(isUnresolvedItem(draft)).toBe(true);
  });

  it("emits traceability for events, forms, items, and codelists", () => {
    const byType = (t: string) => result.traceability.filter((r) => r.odmType === t);
    expect(byType("event")).toHaveLength(3);
    expect(byType("form")).toHaveLength(5);
    expect(byType("item").length).toBeGreaterThanOrEqual(9);
    // SysBP unit (mmHg) and Sex (M/F) carry protocol-constrained codelists.
    expect(byType("codelist").length).toBe(2);
    const week4 = byType("event").find((r) => r.odmOid === "SE.WEEK_4_VISIT");
    expect(week4?.usdmId).toBe("Encounter_Week4");
    expect(result.traceability.find((r) => r.odmOid === "IT.DRAFT_12_LEAD_ECG")?.relation).toBe(
      "placeholder_for",
    );
  });

  it("warns on uncompiled conditional flow", () => {
    expect(result.warnings.some((w) => w.path === "ScheduledDecisionInstance[SDI_Week4Gate]")).toBe(
      true,
    );
  });
});

describe("publish gate", () => {
  it("rejects builds containing unresolved draft items", () => {
    const { definition } = usdmToBuild(demo());
    const errors = validateMetaDataVersion(definition.metaDataVersion).filter(
      (i) => i.severity === "error",
    );
    expect(errors).toHaveLength(3);
    expect(errors.every((e) => e.message.includes("unresolved protocol draft item"))).toBe(true);
  });

  it("accepts the build once surrogates are resolved away", () => {
    const wrapper = demo();
    const version = wrapper.study.versions[0];
    const design = version?.studyDesigns[0];
    if (!version || !design) throw new Error("unreachable");
    version.bcSurrogates = [];
    for (const activity of design.activities) {
      activity.bcSurrogateIds = [];
    }
    const { definition } = usdmToBuild(wrapper);
    const errors = validateMetaDataVersion(definition.metaDataVersion).filter(
      (i) => i.severity === "error",
    );
    expect(errors).toEqual([]);
  });
});

describe("extension round-trip through ODM XML", () => {
  it("preserves edc: provenance attributes across serialize/parse", async () => {
    const { parseOdm, serializeOdm } = await import("@edc-core/odm");
    const { definition } = usdmToBuild(demo(), { protocolVersionId: "pv-123" });
    const file = {
      fileOid: "TEST",
      fileType: "Snapshot",
      odmVersion: "2.0" as const,
      creationDateTime: "2026-07-18T00:00:00Z",
      study: {
        oid: definition.study.oid,
        studyName: definition.study.studyName,
        metaDataVersions: [definition.metaDataVersion],
      },
    };
    const xml = serializeOdm(file, "xml");
    expect(xml).toContain('edc:UsdmEncounterId="Encounter_Week4"');
    expect(xml).toContain('edc:Unresolved="Yes"');

    const reparsed = parseOdm(xml);
    const mdv = reparsed.study?.metaDataVersions[0];
    expect(mdv?.extra?.[PROTOCOL_EXT_ATTRS.protocolVersionId]).toBe("pv-123");
    const week4 = mdv?.studyEventDefs.find((e) => e.oid === "SE.WEEK_4_VISIT");
    expect(week4?.extra?.[PROTOCOL_EXT_ATTRS.timingWindowLabel]).toBe("±3 days");
    const draft = mdv?.itemDefs.find((i) => i.oid === "IT.DRAFT_ADVERSE_EVENTS");
    if (!draft) throw new Error("draft item lost in round-trip");
    expect(isUnresolvedItem(draft)).toBe(true);
  });
});

describe("compiler determinism and OID stability", () => {
  it("compiles the same input to byte-identical output", () => {
    const first = JSON.stringify(usdmToBuild(demo()));
    const second = JSON.stringify(usdmToBuild(demo()));
    expect(second).toBe(first);
  });

  it("keeps item OIDs stable when a concept is renamed but keeps its code", () => {
    const before = usdmToBuild(demo());
    const wrapper = demo();
    const sysBp = wrapper.study.versions[0]?.biomedicalConcepts.find((b) => b.id === "BC_SysBP");
    if (!sysBp) throw new Error("unreachable");
    sysBp.name = "Systolic Blood Pressure (re-labelled)";
    const after = usdmToBuild(wrapper);
    // OIDs derive from the stable synonym, not the display name.
    expect(after.definition.metaDataVersion.itemDefs.map((i) => i.oid)).toEqual(
      before.definition.metaDataVersion.itemDefs.map((i) => i.oid),
    );
  });

  it("keeps existing OIDs stable when the amendment adds a concept", () => {
    const before = usdmToBuild(demo());
    const wrapper = demo();
    const version = wrapper.study.versions[0];
    const design = version?.studyDesigns[0];
    if (!version || !design) throw new Error("unreachable");
    const heartRate = version.biomedicalConcepts.find((b) => b.id === "BC_HeartRate");
    if (!heartRate) throw new Error("unreachable");
    version.biomedicalConcepts.push({
      ...structuredClone(heartRate),
      id: "BC_Temp",
      name: "Temperature",
      synonyms: ["TEMP"],
      code: {
        id: "AliasCode_Temp",
        standardCode: {
          id: "Code_Temp",
          code: "C174446",
          codeSystem: "ncit.nci.nih.gov",
          codeSystemVersion: "2025-04-01",
          decode: "Temperature",
          instanceType: "Code",
        },
        instanceType: "AliasCode",
      },
    });
    const vitals = design.activities.find((a) => a.id === "Activity_VitalSigns");
    vitals?.biomedicalConceptIds.push("BC_Temp");
    const after = usdmToBuild(wrapper);

    const beforeOids = new Set(before.definition.metaDataVersion.itemDefs.map((i) => i.oid));
    const afterOids = new Set(after.definition.metaDataVersion.itemDefs.map((i) => i.oid));
    for (const oid of beforeOids) expect(afterOids.has(oid)).toBe(true);
    expect(afterOids.has("IT.TEMP_VSORRES")).toBe(true);
  });
});
