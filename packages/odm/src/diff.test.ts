import { describe, expect, it } from "vitest";
import { diffMetaDataVersions } from "./diff.js";
import type { MetaDataVersion } from "./model.js";

/** Compact MDV factory: one form (FO.VS) → section (IG.VS) → items. */
function mdv(overrides: Partial<MetaDataVersion> = {}): MetaDataVersion {
  return {
    oid: "MDV.1",
    studyEventDefs: [
      {
        oid: "SE.V1",
        name: "Visit 1",
        itemGroupRefs: [{ itemGroupOid: "FO.VS" }],
      },
    ],
    itemGroupDefs: [
      {
        oid: "FO.VS",
        name: "Vital Signs",
        type: "Form",
        itemRefs: [],
        itemGroupRefs: [{ itemGroupOid: "IG.VS" }],
      },
      {
        oid: "IG.VS",
        name: "Vitals",
        type: "Section",
        itemRefs: [{ itemOid: "IT.HR" }, { itemOid: "IT.SYS", mandatory: "Yes" }],
        itemGroupRefs: [],
      },
    ],
    itemDefs: [
      { oid: "IT.HR", name: "Heart rate", dataType: "integer" },
      {
        oid: "IT.SYS",
        name: "Systolic BP",
        dataType: "integer",
        codeListRef: { codeListOid: "CL.POS" },
      },
    ],
    codeLists: [
      {
        oid: "CL.POS",
        name: "Position",
        dataType: "text",
        items: [{ codedValue: "SITTING" }, { codedValue: "STANDING" }],
      },
    ],
    conditionDefs: [
      {
        oid: "CHK.HR",
        name: "HR plausible",
        description: [{ text: "Heart rate outside 30-220" }],
        formalExpressions: [{ context: "jsonata", code: "IT.HR < 30 or IT.HR > 220" }],
      },
    ],
    methodDefs: [],
    ...overrides,
  } as MetaDataVersion;
}

function clone(base: MetaDataVersion): MetaDataVersion {
  return JSON.parse(JSON.stringify(base));
}

describe("diffMetaDataVersions", () => {
  it("reports no changes for identical builds", () => {
    const a = mdv();
    const diff = diffMetaDataVersions(a, clone(a));
    expect(diff.hasChanges).toBe(false);
    expect(diff.items).toHaveLength(0);
  });

  it("detects added and removed items by (group, item) placement", () => {
    const from = mdv();
    const to = clone(from);
    const section = to.itemGroupDefs.find((g) => g.oid === "IG.VS");
    if (!section) throw new Error("fixture");
    section.itemRefs = section.itemRefs.filter((r) => r.itemOid !== "IT.HR");
    section.itemRefs.push({ itemOid: "IT.DIA" });
    to.itemDefs.push({ oid: "IT.DIA", name: "Diastolic BP", dataType: "integer" });

    const diff = diffMetaDataVersions(from, to);
    expect(diff.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemOid: "IT.HR", itemGroupOid: "IG.VS", kind: "removed" }),
        expect.objectContaining({ itemOid: "IT.DIA", itemGroupOid: "IG.VS", kind: "added" }),
      ]),
    );
    // Group membership itself changed too.
    expect(diff.itemGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oid: "IG.VS", kind: "changed", detail: "item set changed" }),
      ]),
    );
  });

  it("treats an item moved between groups as removed + added", () => {
    const from = mdv();
    const to = clone(from);
    const section = to.itemGroupDefs.find((g) => g.oid === "IG.VS");
    if (!section) throw new Error("fixture");
    section.itemRefs = section.itemRefs.filter((r) => r.itemOid !== "IT.HR");
    to.itemGroupDefs.push({
      oid: "IG.HR",
      name: "Heart",
      type: "Section",
      itemRefs: [{ itemOid: "IT.HR" }],
      itemGroupRefs: [],
    });

    const diff = diffMetaDataVersions(from, to);
    const hr = diff.items.filter((i) => i.itemOid === "IT.HR");
    expect(hr).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemGroupOid: "IG.VS", kind: "removed" }),
        expect.objectContaining({ itemGroupOid: "IG.HR", kind: "added" }),
      ]),
    );
  });

  it("reports dataType, length, and mandatory changes with from/to", () => {
    const from = mdv();
    const to = clone(from);
    const hr = to.itemDefs.find((i) => i.oid === "IT.HR");
    const section = to.itemGroupDefs.find((g) => g.oid === "IG.VS");
    const hrRef = section?.itemRefs.find((r) => r.itemOid === "IT.HR");
    if (!hr || !hrRef) throw new Error("fixture");
    hr.dataType = "text";
    hr.length = 10;
    hrRef.mandatory = "Yes";

    const diff = diffMetaDataVersions(from, to);
    const changed = diff.items.find((i) => i.itemOid === "IT.HR");
    expect(changed?.kind).toBe("changed");
    expect(changed?.changes?.dataType).toEqual({ from: "integer", to: "text" });
    expect(changed?.changes?.length).toEqual({ from: undefined, to: 10 });
    expect(changed?.changes?.mandatory).toEqual({ from: undefined, to: "Yes" });
  });

  it("flags items referencing a codelist whose terms changed", () => {
    const from = mdv();
    const to = clone(from);
    const cl = to.codeLists.find((c) => c.oid === "CL.POS");
    if (!cl) throw new Error("fixture");
    cl.items.push({ codedValue: "SUPINE" });

    const diff = diffMetaDataVersions(from, to);
    expect(diff.codeLists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oid: "CL.POS", kind: "changed", detail: "terms changed" }),
      ]),
    );
    const sys = diff.items.find((i) => i.itemOid === "IT.SYS");
    expect(sys?.changes?.codeListItems).toBe(true);
  });

  it("reports codelist reassignment on the item itself", () => {
    const from = mdv();
    const to = clone(from);
    const sys = to.itemDefs.find((i) => i.oid === "IT.SYS");
    if (!sys) throw new Error("fixture");
    sys.codeListRef = { codeListOid: "CL.OTHER" };
    to.codeLists.push({ oid: "CL.OTHER", name: "Other", dataType: "text", items: [] });

    const diff = diffMetaDataVersions(from, to);
    const item = diff.items.find((i) => i.itemOid === "IT.SYS");
    expect(item?.changes?.codeListOid).toEqual({ from: "CL.POS", to: "CL.OTHER" });
  });

  it("detects edit-check expression changes, additions, and removals", () => {
    const from = mdv();
    const to = clone(from);
    const chk = to.conditionDefs.find((c) => c.oid === "CHK.HR");
    if (!chk || !chk.formalExpressions[0]) throw new Error("fixture");
    chk.formalExpressions[0].code = "IT.HR < 40 or IT.HR > 200";
    to.conditionDefs.push({
      oid: "CHK.SYS",
      name: "Systolic plausible",
      formalExpressions: [{ context: "jsonata", code: "IT.SYS > 250" }],
    });

    const diff = diffMetaDataVersions(from, to);
    expect(diff.editChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oid: "CHK.HR", kind: "changed" }),
        expect.objectContaining({ oid: "CHK.SYS", kind: "added" }),
      ]),
    );

    const removed = diffMetaDataVersions(to, from);
    expect(removed.editChecks).toEqual(
      expect.arrayContaining([expect.objectContaining({ oid: "CHK.SYS", kind: "removed" })]),
    );
  });

  it("detects event and form changes", () => {
    const from = mdv();
    const to = clone(from);
    to.studyEventDefs.push({ oid: "SE.V2", name: "Visit 2", itemGroupRefs: [] });
    const form = to.itemGroupDefs.find((g) => g.oid === "FO.VS");
    if (!form) throw new Error("fixture");
    form.name = "Vital Signs v2";

    const diff = diffMetaDataVersions(from, to);
    expect(diff.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ oid: "SE.V2", kind: "added" })]),
    );
    expect(diff.forms).toEqual(
      expect.arrayContaining([expect.objectContaining({ oid: "FO.VS", kind: "changed" })]),
    );
  });
});
