import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activitiesForEncounter,
  activitiesInOrder,
  bcsForActivity,
  displayLabel,
  encountersInOrder,
  mainTimeline,
  parseUsdm,
  primaryStudyDesign,
  scheduledActivityInstancesInOrder,
  soaMatrix,
  studyVersion,
  timingById,
  timingsForInstance,
} from "./index.js";

const examples = path.join(fileURLToPath(import.meta.url), "../../../../examples");
const wrapper = parseUsdm(readFileSync(path.join(examples, "demo-protocol-usdm.json"), "utf8"));
const version = studyVersion(wrapper);
if (!version) throw new Error("fixture has no study version");
const design = primaryStudyDesign(version);
if (!design) throw new Error("fixture has no study design");

describe("timeline traversal", () => {
  it("walks scheduled activity instances in execution order, skipping decisions", () => {
    const timeline = mainTimeline(design);
    if (!timeline) throw new Error("unreachable");
    expect(scheduledActivityInstancesInOrder(timeline).map((i) => i.id)).toEqual([
      "SAI_Screening",
      "SAI_Baseline",
      "SAI_Week4",
    ]);
  });

  it("orders encounters by first appearance on the main timeline", () => {
    expect(encountersInOrder(design).map((e) => e.id)).toEqual([
      "Encounter_Screening",
      "Encounter_Baseline",
      "Encounter_Week4",
    ]);
  });
});

describe("activity ordering and lookup", () => {
  it("orders top-level activities by the previous/next chain, excluding children", () => {
    expect(activitiesInOrder(design).map((a) => a.id)).toEqual([
      "Activity_Demographics",
      "Activity_VitalSigns",
      "Activity_Safety",
      "Activity_ECG",
    ]);
  });

  it("lists activities for an encounter in timeline order", () => {
    expect(activitiesForEncounter(design, "Encounter_Screening").map((a) => a.id)).toEqual([
      "Activity_Demographics",
      "Activity_VitalSigns",
    ]);
    expect(activitiesForEncounter(design, "Encounter_Week4").map((a) => a.id)).toContain(
      "Activity_ECG",
    );
  });
});

describe("bcsForActivity", () => {
  it("resolves direct concepts and flattens category members", () => {
    const vitals = design.activities.find((a) => a.id === "Activity_VitalSigns");
    if (!vitals) throw new Error("unreachable");
    const resolved = bcsForActivity(version, vitals);
    expect(resolved.concepts.map((bc) => bc.id)).toEqual([
      "BC_Weight",
      "BC_SysBP",
      "BC_DiaBP",
      "BC_HeartRate",
    ]);
    expect(resolved.surrogates).toEqual([]);
  });

  it("resolves surrogates", () => {
    const ecg = design.activities.find((a) => a.id === "Activity_ECG");
    if (!ecg) throw new Error("unreachable");
    const resolved = bcsForActivity(version, ecg);
    expect(resolved.concepts).toEqual([]);
    expect(resolved.surrogates.map((s) => s.name)).toEqual(["12-Lead ECG"]);
  });
});

describe("timing lookup", () => {
  it("finds a timing by id across timelines", () => {
    expect(timingById(design, "Timing_Week4")?.windowLabel).toBe("±3 days");
    expect(timingById(design, "Timing_Missing")).toBeUndefined();
  });

  it("finds timings anchored on an instance", () => {
    const timeline = mainTimeline(design);
    if (!timeline) throw new Error("unreachable");
    expect(timingsForInstance(timeline, "SAI_Week4").map((t) => t.id)).toEqual(["Timing_Week4"]);
  });
});

describe("soaMatrix", () => {
  const matrix = soaMatrix(design);

  it("produces ordered encounter columns and activity rows", () => {
    expect(matrix.encounters.map((e) => e.id)).toEqual([
      "Encounter_Screening",
      "Encounter_Baseline",
      "Encounter_Week4",
    ]);
    expect(matrix.rows.map((r) => r.activity.id)).toEqual([
      "Activity_Demographics",
      "Activity_VitalSigns",
      "Activity_Safety",
      "Activity_ECG",
    ]);
  });

  it("marks the encounters at which each activity is scheduled", () => {
    const row = (id: string) => matrix.rows.find((r) => r.activity.id === id);
    expect(row("Activity_Demographics")?.encounterIds).toEqual(["Encounter_Screening"]);
    expect(row("Activity_VitalSigns")?.encounterIds).toEqual([
      "Encounter_Screening",
      "Encounter_Baseline",
      "Encounter_Week4",
    ]);
    expect(row("Activity_ECG")?.encounterIds).toEqual(["Encounter_Week4"]);
  });

  it("rolls child scheduling up into the parent grouping row", () => {
    const safety = matrix.rows.find((r) => r.activity.id === "Activity_Safety");
    expect(safety?.children.map((c) => c.id)).toEqual([
      "Activity_AdverseEvents",
      "Activity_ConMeds",
    ]);
    expect(safety?.encounterIds).toEqual(["Encounter_Baseline", "Encounter_Week4"]);
  });
});

describe("displayLabel", () => {
  it("prefers label over name", () => {
    expect(displayLabel({ name: "SCREENING", label: "Screening" })).toBe("Screening");
    expect(displayLabel({ name: "SCREENING" })).toBe("SCREENING");
  });
});
