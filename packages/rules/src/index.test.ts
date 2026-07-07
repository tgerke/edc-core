import type { MetaDataVersion } from "@edc-core/odm";
import { describe, expect, it } from "vitest";
import {
  buildRuleContext,
  compileCheck,
  compileEditChecks,
  repeatingGroupOids,
  runChecks,
  runChecksOverRows,
} from "./index.js";

const mdv: MetaDataVersion = {
  oid: "MDV.1",
  studyEventDefs: [],
  itemGroupDefs: [
    {
      oid: "IG.VS",
      name: "Vitals",
      itemRefs: [
        { itemOid: "IT.SYSBP" },
        { itemOid: "IT.DIABP" },
        { itemOid: "IT.MEASURED", collectionExceptionConditionOid: "COND.NOT_DONE" },
      ],
      itemGroupRefs: [],
    },
  ],
  itemDefs: [
    { oid: "IT.SYSBP", name: "Systolic BP", dataType: "integer" },
    { oid: "IT.DIABP", name: "Diastolic BP", dataType: "integer" },
    { oid: "IT.MEASURED", name: "Measured", dataType: "boolean" },
  ],
  codeLists: [],
  conditionDefs: [
    {
      oid: "CHECK.BP_INVERTED",
      name: "Systolic below diastolic",
      description: [{ lang: "en", text: "Systolic BP must exceed diastolic BP" }],
      formalExpressions: [
        {
          context: "jsonata",
          code: "`IT.SYSBP` != null and `IT.DIABP` != null and `IT.SYSBP` <= `IT.DIABP`",
        },
      ],
    },
    {
      oid: "COND.NOT_DONE",
      name: "Vitals not measured",
      formalExpressions: [{ context: "jsonata", code: "`IT.MEASURED` = false" }],
    },
    {
      oid: "COND.OTHER_LANG",
      name: "Non-jsonata condition",
      formalExpressions: [{ context: "xpath", code: "true()" }],
    },
  ],
  methodDefs: [],
};

describe("compileEditChecks", () => {
  it("extracts jsonata conditions, excluding collection exceptions and other contexts", () => {
    const checks = compileEditChecks(mdv);
    expect(checks.map((c) => c.oid)).toEqual(["CHECK.BP_INVERTED"]);
    expect(checks[0]?.message).toBe("Systolic BP must exceed diastolic BP");
  });
});

describe("buildRuleContext", () => {
  it("coerces values per data type and maps empty to null", () => {
    const context = buildRuleContext(mdv, {
      "IT.SYSBP": "120",
      "IT.DIABP": "",
      "IT.MEASURED": "true",
    });
    expect(context).toEqual({ "IT.SYSBP": 120, "IT.DIABP": null, "IT.MEASURED": true });
  });
});

describe("check evaluation", () => {
  const [check] = compileEditChecks(mdv);
  if (!check) throw new Error("check missing");

  it("fires when the data problem is present", async () => {
    const result = await check.evaluate(
      buildRuleContext(mdv, { "IT.SYSBP": "80", "IT.DIABP": "95" }),
    );
    expect(result.fired).toBe(true);
    expect(result.message).toBe("Systolic BP must exceed diastolic BP");
  });

  it("does not fire on valid data or missing values", async () => {
    expect(
      (await check.evaluate(buildRuleContext(mdv, { "IT.SYSBP": "120", "IT.DIABP": "80" }))).fired,
    ).toBe(false);
    expect((await check.evaluate(buildRuleContext(mdv, { "IT.SYSBP": "120" }))).fired).toBe(false);
  });

  it("reports evaluation problems without firing", async () => {
    const broken = compileCheck({ oid: "X", expression: "$unknownFn(1)", message: "m" });
    const result = await broken.evaluate({});
    expect(result.fired).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("treats non-boolean results as not fired", async () => {
    const numeric = compileCheck({ oid: "N", expression: "1 + 1", message: "m" });
    expect((await numeric.evaluate({})).fired).toBe(false);
  });

  it("runChecks maps results by check oid", async () => {
    const results = await runChecks(
      compileEditChecks(mdv),
      buildRuleContext(mdv, { "IT.SYSBP": "80", "IT.DIABP": "95" }),
    );
    expect(results.get("CHECK.BP_INVERTED")?.fired).toBe(true);
  });
});

describe("runChecksOverRows", () => {
  const repeatMdv: MetaDataVersion = {
    ...mdv,
    itemGroupDefs: [
      {
        oid: "IG.DM",
        name: "Demographics",
        itemRefs: [{ itemOid: "IT.AGE" }],
        itemGroupRefs: [],
      },
      {
        oid: "IG.VS",
        name: "Vitals",
        repeating: "Simple",
        itemRefs: [{ itemOid: "IT.SYSBP" }, { itemOid: "IT.DIABP" }],
        itemGroupRefs: [],
      },
    ],
    itemDefs: [...mdv.itemDefs, { oid: "IT.AGE", name: "Age", dataType: "integer" }],
    conditionDefs: [
      ...mdv.conditionDefs,
      {
        oid: "CHECK.AGE",
        name: "Age out of range",
        formalExpressions: [{ context: "jsonata", code: "`IT.AGE` != null and `IT.AGE` > 120" }],
      },
    ],
  };
  const checks = compileEditChecks(repeatMdv);
  const row = (
    itemGroupOid: string,
    itemGroupRepeatKey: number,
    itemOid: string,
    value: string | null,
  ) => ({ itemGroupOid, itemGroupRepeatKey, itemOid, value });

  it("attributes findings in repeating groups to their occurrence", async () => {
    const findings = await runChecksOverRows(checks, repeatMdv, [
      row("IG.DM", 1, "IT.AGE", "44"),
      row("IG.VS", 1, "IT.SYSBP", "120"),
      row("IG.VS", 1, "IT.DIABP", "80"),
      row("IG.VS", 2, "IT.SYSBP", "80"),
      row("IG.VS", 2, "IT.DIABP", "95"),
    ]);
    expect(findings).toEqual([
      {
        checkOid: "CHECK.BP_INVERTED",
        message: "Systolic BP must exceed diastolic BP",
        repeatKey: 2,
      },
    ]);
  });

  it("reports form-level findings once with a null repeat key", async () => {
    const findings = await runChecksOverRows(checks, repeatMdv, [
      row("IG.DM", 1, "IT.AGE", "150"),
      row("IG.VS", 1, "IT.SYSBP", "120"),
      row("IG.VS", 1, "IT.DIABP", "80"),
      row("IG.VS", 2, "IT.SYSBP", "118"),
      row("IG.VS", 2, "IT.DIABP", "78"),
    ]);
    expect(findings).toEqual([
      { checkOid: "CHECK.AGE", message: "Age out of range", repeatKey: null },
    ]);
  });

  it("can fire the same check in multiple occurrences", async () => {
    const findings = await runChecksOverRows(checks, repeatMdv, [
      row("IG.VS", 1, "IT.SYSBP", "70"),
      row("IG.VS", 1, "IT.DIABP", "90"),
      row("IG.VS", 3, "IT.SYSBP", "60"),
      row("IG.VS", 3, "IT.DIABP", "80"),
    ]);
    expect(findings.map((f) => f.repeatKey)).toEqual([1, 3]);
  });

  it("returns nothing for clean data or no checks", async () => {
    expect(
      await runChecksOverRows(checks, repeatMdv, [
        row("IG.VS", 1, "IT.SYSBP", "120"),
        row("IG.VS", 1, "IT.DIABP", "80"),
      ]),
    ).toEqual([]);
    expect(await runChecksOverRows([], repeatMdv, [])).toEqual([]);
  });

  it("repeatingGroupOids reflects the Repeating attribute", () => {
    expect(repeatingGroupOids(repeatMdv)).toEqual(new Set(["IG.VS"]));
  });
});
