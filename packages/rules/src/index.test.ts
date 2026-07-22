import type { MetaDataVersion } from "@edc-core/odm";
import { describe, expect, it } from "vitest";
import {
  buildRuleContext,
  buildSubjectContext,
  compileCheck,
  compileEditChecks,
  evaluateFormState,
  expressionSyntaxError,
  extractFormDependencies,
  hasCrossFormChecks,
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

describe("expressionSyntaxError", () => {
  it("returns null for a valid expression", () => {
    expect(expressionSyntaxError("`IT.WEIGHT` / $power(`IT.HEIGHT` / 100, 2)")).toBeNull();
  });

  it("returns the parser message for a broken expression", () => {
    expect(expressionSyntaxError("`IT.WEIGHT` >")).toMatch(/./);
  });
});

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

// --- Cross-form checks (ADR-0015) ---

const crossFormMdv: MetaDataVersion = {
  oid: "MDV.XF",
  studyEventDefs: [],
  itemGroupDefs: [
    {
      oid: "FO.AE",
      name: "Adverse Events",
      type: "Form",
      itemRefs: [],
      itemGroupRefs: [{ itemGroupOid: "IG.AE" }],
    },
    {
      oid: "IG.AE",
      name: "AE entries",
      repeating: "Yes",
      itemRefs: [{ itemOid: "IT.AESTDT" }, { itemOid: "IT.AETERM" }],
      itemGroupRefs: [],
    },
    {
      oid: "FO.DM",
      name: "Demographics",
      type: "Form",
      itemRefs: [],
      itemGroupRefs: [{ itemGroupOid: "IG.DM" }],
    },
    {
      oid: "IG.DM",
      name: "Demographics section",
      itemRefs: [{ itemOid: "IT.VISDT" }, { itemOid: "IT.SEX" }],
      itemGroupRefs: [],
    },
  ],
  itemDefs: [
    { oid: "IT.AESTDT", name: "AE onset date", dataType: "date" },
    { oid: "IT.AETERM", name: "AE term", dataType: "text" },
    { oid: "IT.VISDT", name: "Visit date", dataType: "date" },
    { oid: "IT.SEX", name: "Sex", dataType: "text" },
  ],
  codeLists: [],
  conditionDefs: [
    {
      oid: "CHECK.AE_BEFORE_VISIT",
      name: "AE onset before the visit",
      description: [{ lang: "en", text: "AE onset date is before the screening visit date" }],
      formalExpressions: [
        {
          context: "jsonata",
          code: "`IT.AESTDT` != null and `IT.AESTDT` < `FO.DM`.`IT.VISDT`",
        },
      ],
    },
    {
      oid: "CHECK.LOCAL_ONLY",
      name: "Local check",
      formalExpressions: [{ context: "jsonata", code: "`IT.AETERM` = ''" }],
    },
  ],
  methodDefs: [],
};

describe("extractFormDependencies", () => {
  it("maps each check to the form OIDs its expression reads", () => {
    const deps = extractFormDependencies(crossFormMdv);
    expect(deps.get("CHECK.AE_BEFORE_VISIT")).toEqual(new Set(["FO.DM"]));
    expect(deps.get("CHECK.LOCAL_ONLY")).toEqual(new Set());
    expect(hasCrossFormChecks(crossFormMdv)).toBe(true);
    expect(hasCrossFormChecks(mdv)).toBe(false);
  });
});

describe("buildSubjectContext", () => {
  it("shapes instances with metadata keys, coerced base values, and occurrence arrays", () => {
    const context = buildSubjectContext(crossFormMdv, [
      {
        formOid: "FO.DM",
        eventOid: "SE.SCR",
        eventRepeatKey: 1,
        formRepeatKey: 1,
        rows: [
          {
            itemGroupOid: "IG.DM",
            itemGroupRepeatKey: 1,
            itemOid: "IT.VISDT",
            value: "2026-06-01",
          },
        ],
      },
      {
        formOid: "FO.AE",
        eventOid: "SE.SCR",
        eventRepeatKey: 1,
        formRepeatKey: 1,
        rows: [
          {
            itemGroupOid: "IG.AE",
            itemGroupRepeatKey: 2,
            itemOid: "IT.AESTDT",
            value: "2026-06-10",
          },
          {
            itemGroupOid: "IG.AE",
            itemGroupRepeatKey: 1,
            itemOid: "IT.AESTDT",
            value: "2026-05-20",
          },
        ],
      },
    ]);
    expect(context["FO.DM"]).toEqual([
      {
        _event_oid: "SE.SCR",
        _event_repeat_key: 1,
        _form_repeat_key: 1,
        "IT.VISDT": "2026-06-01",
      },
    ]);
    expect(context["FO.AE"]?.[0]?.["IG.AE"]).toEqual([
      { _repeat_key: 1, "IT.AESTDT": "2026-05-20" },
      { _repeat_key: 2, "IT.AESTDT": "2026-06-10" },
    ]);
  });
});

describe("cross-form check evaluation", () => {
  const aeRows = [
    { itemGroupOid: "IG.AE", itemGroupRepeatKey: 1, itemOid: "IT.AESTDT", value: "2026-05-20" },
    { itemGroupOid: "IG.AE", itemGroupRepeatKey: 2, itemOid: "IT.AESTDT", value: "2026-06-10" },
  ];
  const subjectContext = buildSubjectContext(crossFormMdv, [
    {
      formOid: "FO.DM",
      eventOid: "SE.SCR",
      eventRepeatKey: 1,
      formRepeatKey: 1,
      rows: [
        { itemGroupOid: "IG.DM", itemGroupRepeatKey: 1, itemOid: "IT.VISDT", value: "2026-06-01" },
      ],
    },
  ]);

  it("fires per occurrence against the referenced form's values", async () => {
    const state = await evaluateFormState(crossFormMdv, aeRows, subjectContext);
    expect(state.findings).toEqual([
      {
        checkOid: "CHECK.AE_BEFORE_VISIT",
        message: "AE onset date is before the screening visit date",
        repeatKey: 1,
      },
    ]);
  });

  it("stays silent without a subject context (single-form behavior unchanged)", async () => {
    const state = await evaluateFormState(crossFormMdv, aeRows);
    expect(state.findings).toEqual([]);
  });
});
