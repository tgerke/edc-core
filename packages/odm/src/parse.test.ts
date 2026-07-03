import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOdm, serializeOdm } from "./index.js";
import { validateMetaDataVersion } from "./validate.js";

const fixtures = path.join(fileURLToPath(import.meta.url), "../../test/fixtures");
const demographics = readFileSync(path.join(fixtures, "cdisc-demographics-race.xml"), "utf8");
const cdashMh = readFileSync(path.join(fixtures, "cdisc-cdash-mh.xml"), "utf8");

describe("parseOdm on CDISC Demographics_RACE example", () => {
  const file = parseOdm(demographics);

  it("reads file and study attributes", () => {
    expect(file.fileOid).toBe("DEMOGRAPHICS_EXAMPLE");
    expect(file.odmVersion).toBe("2.0");
    expect(file.study?.oid).toBe("ST.DEMOGRAPHICS_EXAMPLE");
    expect(file.study?.studyName).toBe("Study with Demographics example");
    expect(file.study?.protocolName).toBe("MyStudy");
  });

  it("reads the metadata version tree", () => {
    const mdv = file.study?.metaDataVersions[0];
    expect(mdv?.oid).toBe("MV.1.0");
    expect(mdv?.studyEventDefs).toHaveLength(1);
    expect(mdv?.studyEventDefs[0]?.itemGroupRefs[0]?.itemGroupOid).toBe("FO.DEMOGRAPHICS");

    // v2.0: forms are ItemGroupDefs with Type="Form"
    const form = mdv?.itemGroupDefs.find((g) => g.type === "Form");
    expect(form?.oid).toBe("FO.DEMOGRAPHICS");
    expect(form?.itemGroupRefs[0]?.itemGroupOid).toBe("IG.DEMOGRAPHICS");

    expect(mdv?.itemDefs.map((i) => i.oid)).toContain("IT.RACEOTH");
    const sex = mdv?.itemDefs.find((i) => i.oid === "IT.SEX");
    expect(sex?.dataType).toBe("integer");
    expect(sex?.codeListRef?.codeListOid).toBe("CL.SEX");
    expect(sex?.question?.[0]?.text).toBe("Sex");

    const race = mdv?.codeLists.find((c) => c.oid === "CL.RACE");
    expect(race?.items).toHaveLength(6);
    expect(race?.items[5]?.codedValue).toBe("99");
    expect(race?.items[5]?.decode?.[0]?.text).toBe("Other - specify");
  });

  it("validates with no referential errors", () => {
    const mdv = file.study?.metaDataVersions[0];
    if (!mdv) throw new Error("fixture has no metadata version");
    const errors = validateMetaDataVersion(mdv).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("round-trips through XML serialization", () => {
    const reparsed = parseOdm(serializeOdm(file, "xml"));
    expect(reparsed).toEqual(file);
  });

  it("round-trips through JSON serialization", () => {
    const reparsed = parseOdm(serializeOdm(file, "json"));
    expect(reparsed).toEqual(file);
  });
});

describe("parseOdm on CDISC CDASH medical-history example", () => {
  const file = parseOdm(cdashMh);
  const mdv = file.study?.metaDataVersions[0];

  it("parses conditions, methods, and preserves unmodeled constructs", () => {
    expect(mdv?.conditionDefs[0]?.oid).toBe("COND.CONDITION_PROCEDURE_NOT_PRESENT");
    expect(mdv?.conditionDefs[0]?.formalExpressions.length).toBeGreaterThan(0);
    expect(mdv?.methodDefs[0]?.oid).toBe("METH.LINE_NUMBER");

    // WhereClauseDef / ValueListDef / RangeCheck are not (yet) modeled but
    // must survive in extra bags rather than disappear.
    const extras = JSON.stringify([mdv?.extra ?? {}, mdv?.itemDefs.map((i) => i.extra ?? {})]);
    expect(extras).toContain("WhereClauseDef");
    expect(extras).toContain("RangeCheck");
  });

  it("resolves CollectionExceptionCondition refs", () => {
    const withCec = mdv?.itemGroupDefs
      .flatMap((g) => g.itemRefs)
      .find((r) => r.collectionExceptionConditionOid);
    expect(withCec?.collectionExceptionConditionOid).toBe("COND.CONDITION_PROCEDURE_NOT_PRESENT");
    const errors = mdv ? validateMetaDataVersion(mdv).filter((i) => i.severity === "error") : [];
    expect(errors).toEqual([]);
  });

  it("round-trips through XML serialization", () => {
    const reparsed = parseOdm(serializeOdm(file, "xml"));
    expect(reparsed).toEqual(file);
  });
});

describe("validateMetaDataVersion failure modes", () => {
  it("flags unresolvable refs, duplicate OIDs, and cycles", () => {
    const issues = validateMetaDataVersion({
      oid: "MDV.BAD",
      studyEventDefs: [
        {
          oid: "SE.1",
          name: "Visit",
          itemGroupRefs: [{ itemGroupOid: "IG.MISSING" }],
        },
      ],
      itemGroupDefs: [
        {
          oid: "IG.A",
          name: "A",
          itemRefs: [{ itemOid: "IT.MISSING" }],
          itemGroupRefs: [{ itemGroupOid: "IG.B" }],
        },
        { oid: "IG.B", name: "B", itemRefs: [], itemGroupRefs: [{ itemGroupOid: "IG.A" }] },
        { oid: "IG.C", name: "C", itemRefs: [], itemGroupRefs: [] },
        { oid: "IG.C", name: "C duplicate", itemRefs: [], itemGroupRefs: [] },
      ],
      itemDefs: [],
      codeLists: [],
      conditionDefs: [],
      methodDefs: [],
    });
    const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
    expect(messages.some((m) => m.includes('"IG.MISSING" does not resolve'))).toBe(true);
    expect(messages.some((m) => m.includes('"IT.MISSING" does not resolve'))).toBe(true);
    expect(messages.some((m) => m.includes("duplicate OID"))).toBe(true);
    expect(messages.some((m) => m.includes("circular ItemGroupRef chain"))).toBe(true);
  });
});

describe("parseOdm error handling", () => {
  it("rejects non-2.0 documents", () => {
    expect(() =>
      parseOdm('<ODM ODMVersion="1.3.2" FileOID="X" FileType="Snapshot" CreationDateTime="now"/>'),
    ).toThrow(/unsupported ODMVersion/);
  });

  it("rejects documents without an ODM root", () => {
    expect(() => parseOdm("<NotOdm/>")).toThrow(/no ODM root/);
  });
});
