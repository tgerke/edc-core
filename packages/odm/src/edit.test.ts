import { describe, expect, it } from "vitest";
import {
  addConditionDef,
  addEvent,
  addForm,
  addItem,
  addMethodDef,
  addSection,
  blankMetaDataVersion,
  conditionReferenceCount,
  deleteGroup,
  generateOid,
  jsonataExpression,
  methodReferenceCount,
  moveItem,
  removeConditionDef,
  removeItem,
  removeMethodDef,
  setGroupCollectionException,
  setItemCollectionException,
  setItemMandatory,
  setItemMethod,
  updateConditionDef,
  updateItemDef,
  updateItemGroup,
  updateMethodDef,
  withDisplayText,
} from "./edit.js";
import type { MetaDataVersion } from "./model.js";
import { displayText } from "./resolve.js";
import { validateMetaDataVersion } from "./validate.js";

/** SE.V1 → FO.VS → { IT.SYSBP, IT.DIABP shared with FO.OTHER, IG.SUB → IT.NESTED } */
function fixture(): MetaDataVersion {
  return {
    oid: "MDV.1",
    studyEventDefs: [
      {
        oid: "SE.V1",
        name: "Visit 1",
        itemGroupRefs: [{ itemGroupOid: "FO.VS" }, { itemGroupOid: "FO.OTHER" }],
      },
    ],
    itemGroupDefs: [
      {
        oid: "FO.VS",
        name: "Vital Signs",
        type: "Form",
        itemRefs: [
          { itemOid: "IT.SYSBP", mandatory: "Yes" },
          { itemOid: "IT.DIABP", mandatory: "No" },
        ],
        itemGroupRefs: [{ itemGroupOid: "IG.SUB" }],
      },
      {
        oid: "FO.OTHER",
        name: "Other",
        type: "Form",
        itemRefs: [{ itemOid: "IT.DIABP" }],
        itemGroupRefs: [],
      },
      {
        oid: "IG.SUB",
        name: "Sub section",
        itemRefs: [{ itemOid: "IT.NESTED" }],
        itemGroupRefs: [],
      },
    ],
    itemDefs: [
      { oid: "IT.SYSBP", name: "Systolic BP", dataType: "integer" },
      { oid: "IT.DIABP", name: "Diastolic BP", dataType: "integer" },
      { oid: "IT.NESTED", name: "Nested item", dataType: "text" },
    ],
    codeLists: [{ oid: "CL.YN", name: "Yes/No", dataType: "text", items: [] }],
    conditionDefs: [],
    methodDefs: [],
  };
}

function errors(mdv: MetaDataVersion) {
  return validateMetaDataVersion(mdv).filter((i) => i.severity === "error");
}

describe("withDisplayText", () => {
  it("creates an entry when empty", () => {
    expect(withDisplayText(undefined, "Hello")).toEqual([{ text: "Hello" }]);
    expect(withDisplayText([], "Hello")).toEqual([{ text: "Hello" }]);
  });

  it("replaces the entry displayText shows, preserving others", () => {
    const texts = [
      { lang: "de", text: "Hallo" },
      { lang: "en", text: "Hello" },
    ];
    const next = withDisplayText(texts, "Hi");
    expect(displayText(next)).toBe("Hi");
    expect(next[0]).toEqual({ lang: "de", text: "Hallo" });
  });
});

describe("generateOid", () => {
  it("slugifies and prefixes", () => {
    expect(generateOid([], "IT", "Pulse rate (bpm)")).toBe("IT.PULSE_RATE_BPM");
  });

  it("suffixes until unique", () => {
    expect(generateOid(["IT.PULSE", "IT.PULSE_2"], "IT", "Pulse")).toBe("IT.PULSE_3");
  });

  it("falls back for unusable names", () => {
    expect(generateOid([], "IT", "???")).toBe("IT.NEW");
  });
});

describe("updateItemDef", () => {
  it("patches fields and leaves the original untouched", () => {
    const mdv = fixture();
    const next = updateItemDef(mdv, "IT.SYSBP", {
      name: "Systolic",
      question: "Systolic blood pressure?",
      dataType: "float",
      length: 5,
      codeListOid: "CL.YN",
    });
    const def = next.itemDefs.find((i) => i.oid === "IT.SYSBP");
    expect(def).toMatchObject({ name: "Systolic", dataType: "float", length: 5 });
    expect(displayText(def?.question)).toBe("Systolic blood pressure?");
    expect(def?.codeListRef?.codeListOid).toBe("CL.YN");
    expect(mdv.itemDefs.find((i) => i.oid === "IT.SYSBP")?.dataType).toBe("integer");
    expect(errors(next)).toEqual([]);
  });

  it("clears length and codelist with null", () => {
    let mdv = updateItemDef(fixture(), "IT.SYSBP", { length: 5, codeListOid: "CL.YN" });
    mdv = updateItemDef(mdv, "IT.SYSBP", { length: null, codeListOid: null });
    const def = mdv.itemDefs.find((i) => i.oid === "IT.SYSBP");
    expect(def?.length).toBeUndefined();
    expect(def?.codeListRef).toBeUndefined();
  });

  it("throws for unknown items", () => {
    expect(() => updateItemDef(fixture(), "IT.MISSING", { name: "x" })).toThrow(/not found/);
  });
});

describe("setItemMandatory", () => {
  it("flips only the ref in the given group", () => {
    const next = setItemMandatory(fixture(), "FO.VS", "IT.DIABP", true);
    const vs = next.itemGroupDefs.find((g) => g.oid === "FO.VS");
    const other = next.itemGroupDefs.find((g) => g.oid === "FO.OTHER");
    expect(vs?.itemRefs.find((r) => r.itemOid === "IT.DIABP")?.mandatory).toBe("Yes");
    expect(other?.itemRefs.find((r) => r.itemOid === "IT.DIABP")?.mandatory).toBeUndefined();
  });
});

describe("addItem / removeItem", () => {
  it("adds a def and ref with a unique OID", () => {
    const { mdv, itemOid } = addItem(fixture(), "FO.VS", {
      name: "Pulse",
      dataType: "integer",
      question: "Pulse rate?",
      mandatory: true,
    });
    expect(itemOid).toBe("IT.PULSE");
    const vs = mdv.itemGroupDefs.find((g) => g.oid === "FO.VS");
    expect(vs?.itemRefs.at(-1)).toEqual({ itemOid, mandatory: "Yes" });
    expect(errors(mdv)).toEqual([]);
  });

  it("removes the def when the last ref is removed", () => {
    const next = removeItem(fixture(), "FO.VS", "IT.SYSBP");
    expect(next.itemDefs.some((i) => i.oid === "IT.SYSBP")).toBe(false);
    expect(errors(next)).toEqual([]);
  });

  it("keeps the def while another group still references it", () => {
    const next = removeItem(fixture(), "FO.VS", "IT.DIABP");
    expect(next.itemDefs.some((i) => i.oid === "IT.DIABP")).toBe(true);
    const other = next.itemGroupDefs.find((g) => g.oid === "FO.OTHER");
    expect(other?.itemRefs.some((r) => r.itemOid === "IT.DIABP")).toBe(true);
  });
});

describe("moveItem", () => {
  it("swaps neighbours and no-ops at edges", () => {
    const mdv = fixture();
    const down = moveItem(mdv, "FO.VS", "IT.SYSBP", 1);
    expect(down.itemGroupDefs[0]?.itemRefs.map((r) => r.itemOid)).toEqual(["IT.DIABP", "IT.SYSBP"]);
    const up = moveItem(mdv, "FO.VS", "IT.SYSBP", -1);
    expect(up.itemGroupDefs[0]?.itemRefs.map((r) => r.itemOid)).toEqual(["IT.SYSBP", "IT.DIABP"]);
  });
});

describe("updateItemGroup", () => {
  it("renames and toggles repeating", () => {
    const next = updateItemGroup(fixture(), "IG.SUB", { name: "Renamed", repeating: true });
    const sub = next.itemGroupDefs.find((g) => g.oid === "IG.SUB");
    expect(sub?.name).toBe("Renamed");
    expect(sub?.repeating).toBe("Simple");
  });
});

describe("addForm / addSection / addEvent", () => {
  it("adds a scheduled form", () => {
    const { mdv, formOid } = addForm(fixture(), { name: "Labs", eventOid: "SE.V1" });
    expect(formOid).toBe("FO.LABS");
    const event = mdv.studyEventDefs[0];
    expect(event?.itemGroupRefs.at(-1)?.itemGroupOid).toBe(formOid);
    expect(mdv.itemGroupDefs.find((g) => g.oid === formOid)?.type).toBe("Form");
    expect(errors(mdv)).toEqual([]);
  });

  it("rejects unknown events", () => {
    expect(() => addForm(fixture(), { name: "Labs", eventOid: "SE.MISSING" })).toThrow(/not found/);
  });

  it("adds a section inside a form", () => {
    const { mdv, groupOid } = addSection(fixture(), "FO.VS", { name: "Extra", repeating: true });
    const vs = mdv.itemGroupDefs.find((g) => g.oid === "FO.VS");
    expect(vs?.itemGroupRefs.at(-1)?.itemGroupOid).toBe(groupOid);
    expect(mdv.itemGroupDefs.find((g) => g.oid === groupOid)?.repeating).toBe("Simple");
    expect(errors(mdv)).toEqual([]);
  });

  it("adds an event", () => {
    const { mdv, eventOid } = addEvent(fixture(), { name: "Week 4" });
    expect(mdv.studyEventDefs.some((e) => e.oid === eventOid)).toBe(true);
    expect(errors(mdv)).toEqual([]);
  });
});

describe("deleteGroup", () => {
  it("cascades to descendants that became unreferenced", () => {
    const next = deleteGroup(fixture(), "FO.VS");
    expect(next.itemGroupDefs.map((g) => g.oid)).toEqual(["FO.OTHER"]);
    // IT.SYSBP and IT.NESTED orphaned; IT.DIABP survives via FO.OTHER.
    expect(next.itemDefs.map((i) => i.oid)).toEqual(["IT.DIABP"]);
    expect(next.studyEventDefs[0]?.itemGroupRefs).toEqual([{ itemGroupOid: "FO.OTHER" }]);
    expect(errors(next)).toEqual([]);
  });

  it("keeps a shared section referenced elsewhere", () => {
    const mdv = fixture();
    // FO.OTHER also embeds IG.SUB.
    const shared: MetaDataVersion = {
      ...mdv,
      itemGroupDefs: mdv.itemGroupDefs.map((g) =>
        g.oid === "FO.OTHER" ? { ...g, itemGroupRefs: [{ itemGroupOid: "IG.SUB" }] } : g,
      ),
    };
    const next = deleteGroup(shared, "FO.VS");
    expect(next.itemGroupDefs.some((g) => g.oid === "IG.SUB")).toBe(true);
    expect(next.itemDefs.some((i) => i.oid === "IT.NESTED")).toBe(true);
    expect(errors(next)).toEqual([]);
  });

  it("deletes a section from its parent form", () => {
    const next = deleteGroup(fixture(), "IG.SUB");
    const vs = next.itemGroupDefs.find((g) => g.oid === "FO.VS");
    expect(vs?.itemGroupRefs).toEqual([]);
    expect(next.itemDefs.some((i) => i.oid === "IT.NESTED")).toBe(false);
    expect(errors(next)).toEqual([]);
  });
});

describe("condition and method authoring", () => {
  it("addConditionDef creates a def with a jsonata expression", () => {
    const { mdv, conditionOid } = addConditionDef(fixture(), {
      name: "Subject is male",
      expression: "`IT.SYSBP` > 0",
      description: "Skipped for male subjects",
    });
    expect(conditionOid).toBe("CD.SUBJECT_IS_MALE");
    const def = mdv.conditionDefs.find((c) => c.oid === conditionOid);
    expect(jsonataExpression(def ?? { formalExpressions: [] })).toBe("`IT.SYSBP` > 0");
    expect(displayText(def?.description)).toBe("Skipped for male subjects");
    expect(errors(mdv)).toEqual([]);
  });

  it("updateConditionDef replaces the jsonata expression, preserving other contexts", () => {
    let { mdv, conditionOid } = addConditionDef(fixture(), { name: "C" });
    mdv = {
      ...mdv,
      conditionDefs: mdv.conditionDefs.map((c) =>
        c.oid === conditionOid
          ? { ...c, formalExpressions: [{ context: "xpath", code: "//x" }] }
          : c,
      ),
    };
    const next = updateConditionDef(mdv, conditionOid, { expression: "true", name: "C2" });
    const def = next.conditionDefs.find((c) => c.oid === conditionOid);
    expect(def?.name).toBe("C2");
    expect(def?.formalExpressions).toEqual([
      { context: "xpath", code: "//x" },
      { context: "jsonata", code: "true" },
    ]);
    expect(
      jsonataExpression(
        updateConditionDef(next, conditionOid, { expression: null }).conditionDefs[0] ?? {
          formalExpressions: [],
        },
      ),
    ).toBeUndefined();
  });

  it("setItemCollectionException wires and clears the skip condition", () => {
    let { mdv, conditionOid } = addConditionDef(fixture(), { name: "C", expression: "true" });
    mdv = setItemCollectionException(mdv, "FO.VS", "IT.DIABP", conditionOid);
    expect(conditionReferenceCount(mdv, conditionOid)).toBe(1);
    const ref = mdv.itemGroupDefs
      .find((g) => g.oid === "FO.VS")
      ?.itemRefs.find((r) => r.itemOid === "IT.DIABP");
    expect(ref?.collectionExceptionConditionOid).toBe(conditionOid);
    expect(errors(mdv)).toEqual([]);
    const cleared = setItemCollectionException(mdv, "FO.VS", "IT.DIABP", null);
    expect(conditionReferenceCount(cleared, conditionOid)).toBe(0);
  });

  it("setGroupCollectionException wires the section ref in its parent", () => {
    let { mdv, conditionOid } = addConditionDef(fixture(), { name: "C", expression: "true" });
    mdv = setGroupCollectionException(mdv, "FO.VS", "IG.SUB", conditionOid);
    const ref = mdv.itemGroupDefs
      .find((g) => g.oid === "FO.VS")
      ?.itemGroupRefs.find((r) => r.itemGroupOid === "IG.SUB");
    expect(ref?.collectionExceptionConditionOid).toBe(conditionOid);
    expect(errors(mdv)).toEqual([]);
    expect(
      setGroupCollectionException(mdv, "FO.VS", "IG.SUB", null)
        .itemGroupDefs.find((g) => g.oid === "FO.VS")
        ?.itemGroupRefs.find((r) => r.itemGroupOid === "IG.SUB")?.collectionExceptionConditionOid,
    ).toBeUndefined();
  });

  it("rejects wiring a condition that does not exist", () => {
    expect(() => setItemCollectionException(fixture(), "FO.VS", "IT.DIABP", "CD.NOPE")).toThrow(
      /not found/,
    );
  });

  it("removeConditionDef refuses while referenced, then deletes", () => {
    let { mdv, conditionOid } = addConditionDef(fixture(), { name: "C", expression: "true" });
    mdv = setItemCollectionException(mdv, "FO.VS", "IT.DIABP", conditionOid);
    expect(() => removeConditionDef(mdv, conditionOid)).toThrow(/referenced/);
    const unwired = setItemCollectionException(mdv, "FO.VS", "IT.DIABP", null);
    expect(removeConditionDef(unwired, conditionOid).conditionDefs).toEqual([]);
  });

  it("addMethodDef creates a Computation method", () => {
    const { mdv, methodOid } = addMethodDef(fixture(), {
      name: "BMI",
      expression: "`IT.SYSBP` * 2",
    });
    expect(methodOid).toBe("MET.BMI");
    expect(mdv.methodDefs[0]?.type).toBe("Computation");
    expect(errors(mdv)).toEqual([]);
  });

  it("setItemMethod forces Mandatory=No and clears cleanly", () => {
    let { mdv, methodOid } = addMethodDef(fixture(), { name: "M", expression: "1" });
    mdv = setItemMethod(mdv, "FO.VS", "IT.SYSBP", methodOid);
    const ref = mdv.itemGroupDefs
      .find((g) => g.oid === "FO.VS")
      ?.itemRefs.find((r) => r.itemOid === "IT.SYSBP");
    expect(ref).toMatchObject({ methodOid, mandatory: "No" });
    expect(methodReferenceCount(mdv, methodOid)).toBe(1);
    expect(errors(mdv)).toEqual([]);
    expect(() => removeMethodDef(mdv, methodOid)).toThrow(/referenced/);
    const cleared = setItemMethod(mdv, "FO.VS", "IT.SYSBP", null);
    expect(
      cleared.itemGroupDefs
        .find((g) => g.oid === "FO.VS")
        ?.itemRefs.find((r) => r.itemOid === "IT.SYSBP")?.methodOid,
    ).toBeUndefined();
    expect(removeMethodDef(cleared, methodOid).methodDefs).toEqual([]);
  });

  it("updateMethodDef patches name and description", () => {
    const { mdv, methodOid } = addMethodDef(fixture(), { name: "M" });
    const next = updateMethodDef(mdv, methodOid, { name: "M2", description: "computes" });
    expect(next.methodDefs[0]?.name).toBe("M2");
    expect(displayText(next.methodDefs[0]?.description)).toBe("computes");
  });
});

describe("blankMetaDataVersion", () => {
  it("is valid and contains a scheduled form", () => {
    const mdv = blankMetaDataVersion("Demo");
    expect(errors(mdv)).toEqual([]);
    expect(mdv.studyEventDefs).toHaveLength(1);
    expect(mdv.itemGroupDefs[0]?.type).toBe("Form");
  });
});
