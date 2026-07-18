import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUsdm, validateUsdmPackage } from "./index.js";
import type { UsdmWrapper } from "./model.js";

const examples = path.join(fileURLToPath(import.meta.url), "../../../../examples");
const demoProtocol = readFileSync(path.join(examples, "demo-protocol-usdm.json"), "utf8");

function demo(): UsdmWrapper {
  return parseUsdm(demoProtocol);
}

function design(wrapper: UsdmWrapper) {
  const d = wrapper.study.versions[0]?.studyDesigns[0];
  if (!d) throw new Error("fixture has no study design");
  return d;
}

function errors(wrapper: UsdmWrapper): string[] {
  return validateUsdmPackage(wrapper)
    .filter((i) => i.severity === "error")
    .map((i) => `${i.path}: ${i.message}`);
}

describe("validateUsdmPackage on the demo protocol", () => {
  it("finds no issues", () => {
    expect(validateUsdmPackage(demo())).toEqual([]);
  });
});

describe("validateUsdmPackage structural expectations", () => {
  it("errors when no StudyVersion is present", () => {
    const wrapper = demo();
    wrapper.study.versions = [];
    expect(errors(wrapper)).toEqual(["study: no StudyVersion present"]);
  });

  it("warns on multiple StudyVersions and non-4.x usdmVersion", () => {
    const wrapper = demo();
    const version = wrapper.study.versions[0];
    if (!version) throw new Error("unreachable");
    wrapper.study.versions.push({ ...version, id: "StudyVersion_2" });
    wrapper.usdmVersion = "3.0.0";
    const warnings = validateUsdmPackage(wrapper).filter((i) => i.severity === "warning");
    expect(warnings.some((w) => w.path === "usdmVersion")).toBe(true);
    expect(warnings.some((w) => w.message.includes("only the first is used"))).toBe(true);
  });

  it("errors when a design has no main timeline", () => {
    const wrapper = demo();
    const timeline = design(wrapper).scheduleTimelines[0];
    if (!timeline) throw new Error("unreachable");
    timeline.mainTimeline = false;
    expect(errors(wrapper)).toContain("StudyDesign[StudyDesign_1]: no main ScheduleTimeline");
  });
});

describe("validateUsdmPackage cross-reference integrity", () => {
  it("errors on a dangling activity biomedicalConceptId", () => {
    const wrapper = demo();
    design(wrapper).activities[0]?.biomedicalConceptIds.push("BC_Missing");
    expect(errors(wrapper)).toContain(
      'Activity[Activity_Demographics]: biomedicalConceptId → "BC_Missing" does not resolve to a BiomedicalConcept',
    );
  });

  it("errors on a dangling scheduled instance encounterId", () => {
    const wrapper = demo();
    const timeline = design(wrapper).scheduleTimelines[0];
    const instance = timeline?.instances.find((i) => i.id === "SAI_Screening");
    if (instance?.instanceType !== "ScheduledActivityInstance") throw new Error("unreachable");
    instance.encounterId = "Encounter_Missing";
    expect(errors(wrapper).some((e) => e.includes("Encounter_Missing"))).toBe(true);
  });

  it("errors on a dangling timing reference", () => {
    const wrapper = demo();
    const timing = design(wrapper).scheduleTimelines[0]?.timings[0];
    if (!timing) throw new Error("unreachable");
    timing.relativeFromScheduledInstanceId = "SAI_Missing";
    expect(errors(wrapper).some((e) => e.includes("SAI_Missing"))).toBe(true);
  });

  it("errors on a dangling encounter scheduledAtId", () => {
    const wrapper = demo();
    const encounter = design(wrapper).encounters[0];
    if (!encounter) throw new Error("unreachable");
    encounter.scheduledAtId = "Timing_Missing";
    expect(errors(wrapper)).toContain(
      'Encounter[Encounter_Screening]: scheduledAtId → "Timing_Missing" does not resolve to a Timing',
    );
  });

  it("errors on a dangling category memberId", () => {
    const wrapper = demo();
    wrapper.study.versions[0]?.bcCategories[0]?.memberIds.push("BC_Missing");
    expect(errors(wrapper)).toContain(
      'BiomedicalConceptCategory[BCCategory_VitalSigns]: memberId → "BC_Missing" does not resolve to a BiomedicalConcept',
    );
  });

  it("errors on a dangling decision conditionTargetId", () => {
    const wrapper = demo();
    const gate = design(wrapper).scheduleTimelines[0]?.instances.find(
      (i) => i.id === "SDI_Week4Gate",
    );
    if (gate?.instanceType !== "ScheduledDecisionInstance") throw new Error("unreachable");
    const assignment = gate.conditionAssignments[0];
    if (!assignment) throw new Error("unreachable");
    assignment.conditionTargetId = "SAI_Missing";
    expect(errors(wrapper).some((e) => e.includes('conditionTargetId → "SAI_Missing"'))).toBe(true);
  });

  it("errors on duplicate ids", () => {
    const wrapper = demo();
    const d = design(wrapper);
    const activity = d.activities[0];
    if (!activity) throw new Error("unreachable");
    d.activities.push({ ...activity });
    expect(errors(wrapper).some((e) => e.includes("duplicate id"))).toBe(true);
  });
});

describe("validateUsdmPackage reachability warnings", () => {
  it("warns on an activity that is never scheduled", () => {
    const wrapper = demo();
    design(wrapper).activities.push({
      id: "Activity_Orphan",
      name: "Orphan",
      childIds: [],
      biomedicalConceptIds: [],
      bcCategoryIds: [],
      bcSurrogateIds: [],
      instanceType: "Activity",
    });
    const warnings = validateUsdmPackage(wrapper).filter((i) => i.severity === "warning");
    expect(warnings.some((w) => w.path === "Activity[Activity_Orphan]")).toBe(true);
  });

  it("warns on an encounter that is never scheduled", () => {
    const wrapper = demo();
    const timeline = design(wrapper).scheduleTimelines[0];
    const week4 = timeline?.instances.find((i) => i.id === "SAI_Week4");
    if (week4?.instanceType !== "ScheduledActivityInstance") throw new Error("unreachable");
    week4.encounterId = "Encounter_Baseline";
    const warnings = validateUsdmPackage(wrapper).filter((i) => i.severity === "warning");
    expect(warnings.some((w) => w.path === "Encounter[Encounter_Week4]")).toBe(true);
  });
});
