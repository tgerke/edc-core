import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUsdm } from "./index.js";

const examples = path.join(fileURLToPath(import.meta.url), "../../../../examples");
const demoProtocol = readFileSync(path.join(examples, "demo-protocol-usdm.json"), "utf8");

describe("parseUsdm on the demo protocol", () => {
  const wrapper = parseUsdm(demoProtocol);

  it("reads the wrapper attributes", () => {
    expect(wrapper.usdmVersion).toBe("4.0.0");
    expect(wrapper.systemName).toBe("edc-core demo");
    expect(wrapper.study.name).toBe("DEMO-PROT");
  });

  it("reads the study version and identifiers", () => {
    const version = wrapper.study.versions[0];
    expect(version?.versionIdentifier).toBe("1.0");
    expect(version?.studyIdentifiers[0]?.text).toBe("DEMO-PROT");
    expect(version?.titles[0]?.type.code).toBe("C207616");
    expect(version?.organizations[0]?.name).toBe("Demo Sponsor");
  });

  it("reads biomedical concepts, categories, and surrogates from the version", () => {
    const version = wrapper.study.versions[0];
    expect(version?.biomedicalConcepts.map((bc) => bc.code.standardCode.code)).toContain("C25298");
    expect(version?.bcCategories[0]?.memberIds).toContain("BC_HeartRate");
    expect(version?.bcSurrogates.map((s) => s.name)).toContain("12-Lead ECG");

    const sysBp = version?.biomedicalConcepts.find((bc) => bc.id === "BC_SysBP");
    const result = sysBp?.properties.find((p) => p.id === "BCProp_SysBP_Result");
    expect(result?.isRequired).toBe(true);
    expect(result?.datatype).toBe("decimal");
    const unit = sysBp?.properties.find((p) => p.id === "BCProp_SysBP_Unit");
    expect(unit?.responseCodes[0]?.code.code).toBe("C49670");
  });

  it("reads the study design tree", () => {
    const design = wrapper.study.versions[0]?.studyDesigns[0];
    expect(design?.instanceType).toBe("InterventionalStudyDesign");
    expect(design?.encounters).toHaveLength(3);
    expect(design?.activities).toHaveLength(6);
    expect(design?.epochs.map((e) => e.type?.code)).toEqual(["C48262", "C101526"]);

    const timeline = design?.scheduleTimelines[0];
    expect(timeline?.mainTimeline).toBe(true);
    expect(timeline?.entryId).toBe("SAI_Screening");
    expect(timeline?.instances).toHaveLength(4);
    expect(timeline?.timings).toHaveLength(3);
  });

  it("discriminates scheduled activity and decision instances", () => {
    const timeline = wrapper.study.versions[0]?.studyDesigns[0]?.scheduleTimelines[0];
    const gate = timeline?.instances.find((i) => i.id === "SDI_Week4Gate");
    expect(gate?.instanceType).toBe("ScheduledDecisionInstance");
    if (gate?.instanceType === "ScheduledDecisionInstance") {
      expect(gate.conditionAssignments[0]?.conditionTargetId).toBe("SAI_Week4");
    }
    const week4 = timeline?.instances.find((i) => i.id === "SAI_Week4");
    expect(week4?.instanceType).toBe("ScheduledActivityInstance");
    if (week4?.instanceType === "ScheduledActivityInstance") {
      expect(week4.timelineExitId).toBe("TimelineExit_1");
    }
  });

  it("accepts pre-parsed JSON and ignores unknown keys", () => {
    const raw = JSON.parse(demoProtocol);
    raw.study.versions[0].notes = [{ id: "Note_1", text: "unmodeled" }];
    const reparsed = parseUsdm(raw);
    expect(reparsed.study.name).toBe("DEMO-PROT");
  });
});

describe("parseUsdm on malformed content", () => {
  it("rejects a wrapper without usdmVersion", () => {
    expect(() => parseUsdm({ study: { name: "X", instanceType: "Study" } })).toThrow();
  });

  it("rejects a timing without a value", () => {
    const raw = JSON.parse(demoProtocol);
    raw.study.versions[0].studyDesigns[0].scheduleTimelines[0].timings[0].value = undefined;
    expect(() => parseUsdm(raw)).toThrow();
  });

  it("rejects non-JSON strings", () => {
    expect(() => parseUsdm("<Odm/>")).toThrow();
  });
});
