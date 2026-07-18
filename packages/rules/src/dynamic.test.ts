import type { MetaDataVersion } from "@edc-core/odm";
import { describe, expect, it } from "vitest";
import {
  compileDerivations,
  compileEditChecks,
  evaluateFormState,
  fieldKey,
  type ItemValueRow,
  skipCheckOid,
} from "./index.js";

const mdv: MetaDataVersion = {
  oid: "MDV.1",
  studyEventDefs: [],
  itemGroupDefs: [
    {
      oid: "IG.DM",
      name: "Demographics",
      itemRefs: [
        { itemOid: "IT.SEX" },
        { itemOid: "IT.SMOKER" },
        { itemOid: "IT.CIGS", collectionExceptionConditionOid: "CD.NONSMOKER" },
        { itemOid: "IT.WT" },
        { itemOid: "IT.HT" },
        { itemOid: "IT.BMI", methodOid: "MET.BMI" },
        { itemOid: "IT.INT" },
      ],
      itemGroupRefs: [{ itemGroupOid: "IG.PREG", collectionExceptionConditionOid: "CD.MALE" }],
    },
    {
      oid: "IG.PREG",
      name: "Pregnancy",
      itemRefs: [{ itemOid: "IT.PREG" }],
      itemGroupRefs: [{ itemGroupOid: "IG.PREGDET" }],
    },
    {
      oid: "IG.PREGDET",
      name: "Pregnancy detail",
      itemRefs: [{ itemOid: "IT.PREGDT" }],
      itemGroupRefs: [],
    },
    {
      oid: "IG.VS",
      name: "Vitals",
      repeating: "Simple",
      itemRefs: [
        { itemOid: "IT.HRMEAS" },
        { itemOid: "IT.HR", collectionExceptionConditionOid: "CD.HRND" },
        { itemOid: "IT.HRUNIT" },
      ],
      itemGroupRefs: [],
    },
  ],
  itemDefs: [
    { oid: "IT.SEX", name: "Sex", dataType: "text" },
    { oid: "IT.SMOKER", name: "Smoker", dataType: "text" },
    { oid: "IT.CIGS", name: "Cigarettes per day", dataType: "integer" },
    { oid: "IT.WT", name: "Weight (kg)", dataType: "float" },
    { oid: "IT.HT", name: "Height (m)", dataType: "float" },
    { oid: "IT.BMI", name: "BMI", dataType: "float" },
    {
      oid: "IT.INT",
      name: "Exercise intensity",
      dataType: "text",
      codeListRef: { codeListOid: "CL.INT" },
    },
    { oid: "IT.PREG", name: "Pregnancy test", dataType: "text" },
    { oid: "IT.PREGDT", name: "Pregnancy test date", dataType: "text" },
    { oid: "IT.HRMEAS", name: "HR measured", dataType: "boolean" },
    { oid: "IT.HR", name: "Heart rate", dataType: "integer" },
    {
      oid: "IT.HRUNIT",
      name: "HR unit",
      dataType: "text",
      codeListRef: { codeListOid: "CL.HRUNIT" },
    },
  ],
  codeLists: [
    {
      oid: "CL.INT",
      name: "Intensity",
      dataType: "text",
      items: [
        { codedValue: "MILD" },
        { codedValue: "VIGOROUS", collectionExceptionConditionOid: "CD.OBESE" },
      ],
    },
    {
      oid: "CL.HRUNIT",
      name: "HR unit",
      dataType: "text",
      items: [
        { codedValue: "BPM" },
        { codedValue: "OTHER", collectionExceptionConditionOid: "CD.TACHY" },
      ],
    },
  ],
  conditionDefs: [
    {
      oid: "CD.NONSMOKER",
      name: "Not a smoker",
      formalExpressions: [{ context: "jsonata", code: '`IT.SMOKER` != "Y"' }],
    },
    {
      oid: "CD.MALE",
      name: "Subject is male",
      formalExpressions: [{ context: "jsonata", code: '`IT.SEX` = "M"' }],
    },
    {
      oid: "CD.HRND",
      name: "HR not measured",
      formalExpressions: [{ context: "jsonata", code: "`IT.HRMEAS` = false" }],
    },
    {
      oid: "CD.OBESE",
      name: "BMI is 30 or above",
      formalExpressions: [{ context: "jsonata", code: "`IT.BMI` != null and `IT.BMI` >= 30" }],
    },
    {
      oid: "CD.TACHY",
      name: "HR above 100",
      formalExpressions: [{ context: "jsonata", code: "`IT.HR` != null and `IT.HR` > 100" }],
    },
    {
      oid: "CHECK.CIGS",
      name: "Implausible cigarette count",
      description: [{ lang: "en", text: "Cigarettes per day above 40" }],
      formalExpressions: [{ context: "jsonata", code: "`IT.CIGS` != null and `IT.CIGS` > 40" }],
    },
    {
      oid: "CHECK.BMI",
      name: "Implausible BMI",
      description: [{ lang: "en", text: "BMI above 60" }],
      formalExpressions: [{ context: "jsonata", code: "`IT.BMI` != null and `IT.BMI` > 60" }],
    },
  ],
  methodDefs: [
    {
      oid: "MET.BMI",
      name: "BMI from weight and height",
      type: "Computation",
      formalExpressions: [
        {
          context: "jsonata",
          code: "`IT.WT` != null and `IT.HT` != null and `IT.HT` > 0 ? `IT.WT` / (`IT.HT` * `IT.HT`) : null",
        },
      ],
    },
  ],
};

const row = (
  itemGroupOid: string,
  itemGroupRepeatKey: number,
  itemOid: string,
  value: string | null,
): ItemValueRow => ({ itemGroupOid, itemGroupRepeatKey, itemOid, value });

describe("compileEditChecks with dynamic constructs", () => {
  it("excludes group-level and option-level collection exceptions from checks", () => {
    expect(compileEditChecks(mdv).map((c) => c.oid)).toEqual(["CHECK.CIGS", "CHECK.BMI"]);
  });
});

describe("evaluateFormState: derivations", () => {
  it("computes derived values and exposes them to checks", async () => {
    const state = await evaluateFormState(mdv, [
      row("IG.DM", 1, "IT.SEX", "M"),
      row("IG.DM", 1, "IT.WT", "200"),
      row("IG.DM", 1, "IT.HT", "1.5"),
    ]);
    const bmi = state.derived.find((d) => d.itemOid === "IT.BMI");
    expect(bmi?.value).toBe(String(200 / (1.5 * 1.5)));
    // BMI ≈ 88.9 — the edit check on the derived value fires.
    expect(state.findings.map((f) => f.checkOid)).toContain("CHECK.BMI");
  });

  it("yields null when inputs are missing or the expression fails", async () => {
    const state = await evaluateFormState(mdv, [row("IG.DM", 1, "IT.WT", "80")]);
    expect(state.derived.find((d) => d.itemOid === "IT.BMI")?.value).toBeNull();

    const broken: MetaDataVersion = structuredClone(mdv);
    const method = broken.methodDefs.find((m) => m.oid === "MET.BMI");
    if (!method?.formalExpressions[0]) throw new Error("fixture");
    method.formalExpressions[0].code = "$noSuchFunction(1)";
    const brokenState = await evaluateFormState(broken, [
      row("IG.DM", 1, "IT.WT", "80"),
      row("IG.DM", 1, "IT.HT", "1.8"),
    ]);
    expect(brokenState.derived.find((d) => d.itemOid === "IT.BMI")?.value).toBeNull();
  });

  it("orders chained derivations and drops cycles defensively", () => {
    const chained: MetaDataVersion = structuredClone(mdv);
    const dm = chained.itemGroupDefs.find((g) => g.oid === "IG.DM");
    if (!dm) throw new Error("fixture");
    chained.itemDefs.push({ oid: "IT.BMICAT", name: "BMI category", dataType: "text" });
    // Declared before IT.BMI's ref order in methods list; topo order must win.
    dm.itemRefs.unshift({ itemOid: "IT.BMICAT", methodOid: "MET.BMICAT" });
    chained.methodDefs.push({
      oid: "MET.BMICAT",
      name: "Category",
      type: "Computation",
      formalExpressions: [
        { context: "jsonata", code: '`IT.BMI` = null ? null : `IT.BMI` >= 30 ? "obese" : "other"' },
      ],
    });
    expect(compileDerivations(chained).map((d) => d.itemOid)).toEqual(["IT.BMI", "IT.BMICAT"]);

    const cyclic = structuredClone(chained);
    const bmiMethod = cyclic.methodDefs.find((m) => m.oid === "MET.BMI");
    if (!bmiMethod?.formalExpressions[0]) throw new Error("fixture");
    bmiMethod.formalExpressions[0].code = "`IT.BMICAT` != null ? 1 : 0";
    expect(compileDerivations(cyclic)).toEqual([]);
  });

  it("computes chained derivations through the pipeline", async () => {
    const chained: MetaDataVersion = structuredClone(mdv);
    const dm = chained.itemGroupDefs.find((g) => g.oid === "IG.DM");
    if (!dm) throw new Error("fixture");
    chained.itemDefs.push({ oid: "IT.BMICAT", name: "BMI category", dataType: "text" });
    dm.itemRefs.unshift({ itemOid: "IT.BMICAT", methodOid: "MET.BMICAT" });
    chained.methodDefs.push({
      oid: "MET.BMICAT",
      name: "Category",
      type: "Computation",
      formalExpressions: [
        { context: "jsonata", code: '`IT.BMI` = null ? null : `IT.BMI` >= 30 ? "obese" : "other"' },
      ],
    });
    const state = await evaluateFormState(chained, [
      row("IG.DM", 1, "IT.WT", "100"),
      row("IG.DM", 1, "IT.HT", "1.6"),
    ]);
    expect(state.derived.find((d) => d.itemOid === "IT.BMICAT")?.value).toBe("obese");
  });
});

describe("evaluateFormState: skip logic", () => {
  it("skips an item when its collection exception is true and nulls it for checks", async () => {
    const state = await evaluateFormState(mdv, [
      row("IG.DM", 1, "IT.SMOKER", "N"),
      row("IG.DM", 1, "IT.CIGS", "60"),
    ]);
    expect(state.skippedFields.has(fieldKey("IG.DM", 1, "IT.CIGS"))).toBe(true);
    // The stored 60 would fire CHECK.CIGS, but skipped values are nulled first.
    expect(state.findings).toEqual([]);
    // The stored value is flagged as a residual instead.
    expect(state.residuals).toEqual([
      expect.objectContaining({
        checkOid: skipCheckOid("CD.NONSMOKER", "IT.CIGS"),
        itemGroupOid: "IG.DM",
        itemOid: "IT.CIGS",
        repeatKey: null,
      }),
    ]);
  });

  it("collects the item and fires checks when the exception is false", async () => {
    const state = await evaluateFormState(mdv, [
      row("IG.DM", 1, "IT.SMOKER", "Y"),
      row("IG.DM", 1, "IT.CIGS", "60"),
    ]);
    expect(state.skippedFields.has(fieldKey("IG.DM", 1, "IT.CIGS"))).toBe(false);
    expect(state.findings.map((f) => f.checkOid)).toEqual(["CHECK.CIGS"]);
    expect(state.residuals).toEqual([]);
  });

  it("cascades a group-level skip to nested groups", async () => {
    const state = await evaluateFormState(mdv, [
      row("IG.DM", 1, "IT.SEX", "M"),
      row("IG.PREG", 1, "IT.PREG", "NEG"),
    ]);
    expect(state.skippedFields.has(fieldKey("IG.PREG", 1, "IT.PREG"))).toBe(true);
    expect(state.skippedFields.has(fieldKey("IG.PREGDET", 1, "IT.PREGDT"))).toBe(true);
    expect(state.residuals.map((r) => r.itemOid)).toEqual(["IT.PREG"]);
  });

  it("does not skip the group when the exception is false", async () => {
    const state = await evaluateFormState(mdv, [row("IG.DM", 1, "IT.SEX", "F")]);
    expect([...state.skippedFields].filter((k) => k.startsWith("IG.PREG"))).toEqual([]);
  });

  it("evaluates item-level skips per occurrence in repeating groups", async () => {
    const state = await evaluateFormState(mdv, [
      row("IG.VS", 1, "IT.HRMEAS", "true"),
      row("IG.VS", 1, "IT.HR", "72"),
      row("IG.VS", 2, "IT.HRMEAS", "false"),
      row("IG.VS", 2, "IT.HR", "88"),
    ]);
    expect(state.skippedFields.has(fieldKey("IG.VS", 1, "IT.HR"))).toBe(false);
    expect(state.skippedFields.has(fieldKey("IG.VS", 2, "IT.HR"))).toBe(true);
    expect(state.residuals).toEqual([expect.objectContaining({ itemOid: "IT.HR", repeatKey: 2 })]);
  });

  it("nulls a skipped derived field instead of flagging a residual", async () => {
    const withSkippedBmi: MetaDataVersion = structuredClone(mdv);
    const ref = withSkippedBmi.itemGroupDefs
      .find((g) => g.oid === "IG.DM")
      ?.itemRefs.find((r) => r.itemOid === "IT.BMI");
    if (!ref) throw new Error("fixture");
    ref.collectionExceptionConditionOid = "CD.MALE";
    const state = await evaluateFormState(withSkippedBmi, [
      row("IG.DM", 1, "IT.SEX", "M"),
      row("IG.DM", 1, "IT.WT", "200"),
      row("IG.DM", 1, "IT.HT", "1.5"),
      row("IG.DM", 1, "IT.BMI", "88.9"),
    ]);
    expect(state.derived.find((d) => d.itemOid === "IT.BMI")?.value).toBeNull();
    expect(state.residuals).toEqual([]);
    // Nulled before checks: CHECK.BMI must not fire.
    expect(state.findings).toEqual([]);
  });
});

describe("evaluateFormState: dependent options", () => {
  it("excludes options based on another field, including derived values", async () => {
    const state = await evaluateFormState(mdv, [
      row("IG.DM", 1, "IT.WT", "100"),
      row("IG.DM", 1, "IT.HT", "1.6"),
    ]);
    // BMI ≈ 39.1 → VIGOROUS excluded for the intensity field.
    expect(state.excludedOptions.get(fieldKey("IG.DM", 1, "IT.INT"))).toEqual(
      new Set(["VIGOROUS"]),
    );
  });

  it("keeps all options when the condition is false", async () => {
    const state = await evaluateFormState(mdv, [
      row("IG.DM", 1, "IT.WT", "60"),
      row("IG.DM", 1, "IT.HT", "1.8"),
    ]);
    expect(state.excludedOptions.get(fieldKey("IG.DM", 1, "IT.INT"))).toBeUndefined();
  });

  it("evaluates option exclusions per occurrence", async () => {
    const state = await evaluateFormState(mdv, [
      row("IG.VS", 1, "IT.HRMEAS", "true"),
      row("IG.VS", 1, "IT.HR", "80"),
      row("IG.VS", 2, "IT.HRMEAS", "true"),
      row("IG.VS", 2, "IT.HR", "120"),
    ]);
    expect(state.excludedOptions.get(fieldKey("IG.VS", 1, "IT.HRUNIT"))).toBeUndefined();
    expect(state.excludedOptions.get(fieldKey("IG.VS", 2, "IT.HRUNIT"))).toEqual(
      new Set(["OTHER"]),
    );
  });
});
