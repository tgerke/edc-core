import { describe, expect, it } from "vitest";
import { parseOdm, serializeOdm, upconvertOdm13Xml } from "./index.js";
import type { MetaDataVersion } from "./model.js";
import { validateMetaDataVersion } from "./validate.js";

const XML = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
    FileOID="BLD" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-07-18T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.DF" StudyName="Dynamic Fields Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.DF" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.DF" Name="Screening" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.MAIN" Mandatory="Yes" OrderNumber="1"/>
        <ItemGroupRef ItemGroupOID="IG.PREG" Mandatory="No" OrderNumber="2" CollectionExceptionConditionOID="CD.MALE"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.MAIN" Name="Demographics" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.SEX" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.SMOKER" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.CIGS" Mandatory="No" CollectionExceptionConditionOID="CD.NONSMOKER"/>
        <ItemRef ItemOID="IT.WT" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.HT" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.BMI" Mandatory="No" MethodOID="MET.BMI"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.PREG" Name="Pregnancy" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.PREG" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.SEX" Name="Sex" DataType="text">
        <CodeListRef CodeListOID="CL.SEX"/>
      </ItemDef>
      <ItemDef OID="IT.SMOKER" Name="Smoker" DataType="text">
        <CodeListRef CodeListOID="CL.YN"/>
      </ItemDef>
      <ItemDef OID="IT.CIGS" Name="Cigarettes per day" DataType="integer"/>
      <ItemDef OID="IT.WT" Name="Weight (kg)" DataType="float"/>
      <ItemDef OID="IT.HT" Name="Height (m)" DataType="float"/>
      <ItemDef OID="IT.BMI" Name="BMI" DataType="float"/>
      <ItemDef OID="IT.PREG" Name="Pregnancy test result" DataType="text">
        <CodeListRef CodeListOID="CL.PREG"/>
      </ItemDef>
      <CodeList OID="CL.SEX" Name="Sex" DataType="text">
        <CodeListItem CodedValue="M"><Decode><TranslatedText xml:lang="en">Male</TranslatedText></Decode></CodeListItem>
        <CodeListItem CodedValue="F"><Decode><TranslatedText xml:lang="en">Female</TranslatedText></Decode></CodeListItem>
      </CodeList>
      <CodeList OID="CL.YN" Name="Yes/No" DataType="text">
        <CodeListItem CodedValue="Y"/>
        <CodeListItem CodedValue="N"/>
      </CodeList>
      <CodeList OID="CL.PREG" Name="Pregnancy result" DataType="text">
        <CodeListItem CodedValue="NEG"/>
        <CodeListItem CodedValue="POS"/>
        <CodeListItem CodedValue="NA" edc:CollectionExceptionConditionOID="CD.FEMALE"/>
      </CodeList>
      <ConditionDef OID="CD.MALE" Name="Subject is male">
        <FormalExpression Context="jsonata">\`IT.SEX\` = "M"</FormalExpression>
      </ConditionDef>
      <ConditionDef OID="CD.FEMALE" Name="Subject is female">
        <FormalExpression Context="jsonata">\`IT.SEX\` = "F"</FormalExpression>
      </ConditionDef>
      <ConditionDef OID="CD.NONSMOKER" Name="Subject is not a smoker">
        <FormalExpression Context="jsonata">\`IT.SMOKER\` != "Y"</FormalExpression>
      </ConditionDef>
      <MethodDef OID="MET.BMI" Name="BMI from weight and height" Type="Computation">
        <FormalExpression Context="jsonata">\`IT.WT\` != null and \`IT.HT\` &gt; 0 ? \`IT.WT\` / (\`IT.HT\` * \`IT.HT\`) : null</FormalExpression>
      </MethodDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

function fixtureMdv(): MetaDataVersion {
  const mdv = parseOdm(XML).study?.metaDataVersions[0];
  if (!mdv) throw new Error("fixture has no metadata version");
  return structuredClone(mdv);
}

describe("collection exceptions and derivations in the typed model", () => {
  const file = parseOdm(XML);
  const mdv = file.study?.metaDataVersions[0];
  if (!mdv) throw new Error("fixture has no metadata version");

  it("parses CollectionExceptionConditionOID on ItemGroupRef", () => {
    const form = mdv.itemGroupDefs.find((g) => g.oid === "FO.DF");
    const pregRef = form?.itemGroupRefs.find((r) => r.itemGroupOid === "IG.PREG");
    expect(pregRef?.collectionExceptionConditionOid).toBe("CD.MALE");
    const mainRef = form?.itemGroupRefs.find((r) => r.itemGroupOid === "IG.MAIN");
    expect(mainRef?.collectionExceptionConditionOid).toBeUndefined();
  });

  it("parses edc:CollectionExceptionConditionOID on CodeListItem", () => {
    const list = mdv.codeLists.find((cl) => cl.oid === "CL.PREG");
    expect(list?.items.find((i) => i.codedValue === "NA")?.collectionExceptionConditionOid).toBe(
      "CD.FEMALE",
    );
    expect(
      list?.items.find((i) => i.codedValue === "NEG")?.collectionExceptionConditionOid,
    ).toBeUndefined();
  });

  it("round-trips through XML with both attributes", () => {
    const xml = serializeOdm(file, "xml");
    expect(xml).toContain('CollectionExceptionConditionOID="CD.MALE"');
    expect(xml).toContain('edc:CollectionExceptionConditionOID="CD.FEMALE"');
    expect(parseOdm(xml)).toEqual(file);
  });

  it("round-trips through JSON", () => {
    expect(parseOdm(serializeOdm(file, "json"))).toEqual(file);
  });

  it("validates cleanly", () => {
    expect(validateMetaDataVersion(mdv).filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("ODM 1.3 upconvert", () => {
  it("carries CollectionExceptionConditionOID on ItemGroupRef through", () => {
    const xml13 = `<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3"
        FileOID="OLD" FileType="Snapshot" ODMVersion="1.3.2"
        CreationDateTime="2026-07-18T00:00:00Z">
      <Study OID="ST.OLD">
        <GlobalVariables><StudyName>Legacy</StudyName></GlobalVariables>
        <MetaDataVersion OID="MDV.1" Name="v1">
          <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
            <FormRef FormOID="FO.A" Mandatory="Yes" OrderNumber="1"/>
          </StudyEventDef>
          <FormDef OID="FO.A" Name="Form A" Repeating="No">
            <ItemGroupRef ItemGroupOID="IG.A" Mandatory="Yes" OrderNumber="1" CollectionExceptionConditionOID="CD.SKIP"/>
          </FormDef>
          <ItemGroupDef OID="IG.A" Name="Group A" Repeating="No">
            <ItemRef ItemOID="IT.A" Mandatory="Yes" OrderNumber="1"/>
          </ItemGroupDef>
          <ItemDef OID="IT.A" Name="Item A" DataType="text"/>
          <ConditionDef OID="CD.SKIP" Name="Skip group A">
            <FormalExpression Context="jsonata">\`IT.A\` = "X"</FormalExpression>
          </ConditionDef>
        </MetaDataVersion>
      </Study>
    </ODM>`;
    const { file } = upconvertOdm13Xml(xml13);
    const form = file.study?.metaDataVersions[0]?.itemGroupDefs.find((g) => g.oid === "FO.A");
    expect(form?.itemGroupRefs[0]?.collectionExceptionConditionOid).toBe("CD.SKIP");
  });
});

describe("validation of dynamic-field constructs", () => {
  const errorsOf = (mdv: MetaDataVersion) =>
    validateMetaDataVersion(mdv).filter((i) => i.severity === "error");
  const warningsOf = (mdv: MetaDataVersion) =>
    validateMetaDataVersion(mdv).filter((i) => i.severity === "warning");

  it("errors when an ItemGroupRef collection exception does not resolve", () => {
    const mdv = fixtureMdv();
    const form = mdv.itemGroupDefs.find((g) => g.oid === "FO.DF");
    const ref = form?.itemGroupRefs.find((r) => r.itemGroupOid === "IG.PREG");
    if (!ref) throw new Error("fixture ref missing");
    ref.collectionExceptionConditionOid = "CD.MISSING";
    expect(errorsOf(mdv)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ItemGroupDef[FO.DF]",
          message: expect.stringContaining("CD.MISSING"),
        }),
      ]),
    );
  });

  it("errors when a CodeListItem collection exception does not resolve", () => {
    const mdv = fixtureMdv();
    const item = mdv.codeLists
      .find((cl) => cl.oid === "CL.PREG")
      ?.items.find((i) => i.codedValue === "NA");
    if (!item) throw new Error("fixture code list item missing");
    item.collectionExceptionConditionOid = "CD.MISSING";
    expect(errorsOf(mdv)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "CodeList[CL.PREG]",
          message: expect.stringContaining("CD.MISSING"),
        }),
      ]),
    );
  });

  it("warns when a referenced collection exception has no jsonata expression", () => {
    const mdv = fixtureMdv();
    const condition = mdv.conditionDefs.find((c) => c.oid === "CD.NONSMOKER");
    if (!condition) throw new Error("fixture condition missing");
    condition.formalExpressions = [{ context: "xpath", code: "IT.SMOKER != 'Y'" }];
    expect(warningsOf(mdv)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ConditionDef[CD.NONSMOKER]",
          message: expect.stringContaining("will not be enforced"),
        }),
      ]),
    );
  });

  it("warns when a referenced method has no jsonata expression", () => {
    const mdv = fixtureMdv();
    const method = mdv.methodDefs.find((m) => m.oid === "MET.BMI");
    if (!method) throw new Error("fixture method missing");
    method.formalExpressions = [];
    expect(warningsOf(mdv)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "MethodDef[MET.BMI]",
          message: expect.stringContaining("will never compute"),
        }),
      ]),
    );
  });

  it("does not warn about unreferenced conditions (plain edit checks are vetted elsewhere)", () => {
    const mdv = fixtureMdv();
    mdv.conditionDefs.push({
      oid: "CHK.LOOSE",
      name: "Unreferenced",
      formalExpressions: [],
    });
    expect(validateMetaDataVersion(mdv).filter((i) => i.path.includes("CHK.LOOSE"))).toEqual([]);
  });

  it("errors on a circular derivation chain", () => {
    const mdv = fixtureMdv();
    const main = mdv.itemGroupDefs.find((g) => g.oid === "IG.MAIN");
    if (!main) throw new Error("fixture group missing");
    mdv.itemDefs.push({ oid: "IT.LOOP", name: "Loop", dataType: "float" });
    main.itemRefs.push({ itemOid: "IT.LOOP", methodOid: "MET.LOOP" });
    mdv.methodDefs.push({
      oid: "MET.LOOP",
      name: "Depends on BMI",
      type: "Computation",
      formalExpressions: [{ context: "jsonata", code: "`IT.BMI` * 2" }],
    });
    const bmiMethod = mdv.methodDefs.find((m) => m.oid === "MET.BMI");
    if (!bmiMethod) throw new Error("fixture method missing");
    bmiMethod.formalExpressions = [{ context: "jsonata", code: "`IT.LOOP` / 2" }];
    expect(errorsOf(mdv)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("circular derivation chain") }),
      ]),
    );
  });

  it("allows acyclic derivation chains", () => {
    const mdv = fixtureMdv();
    const main = mdv.itemGroupDefs.find((g) => g.oid === "IG.MAIN");
    if (!main) throw new Error("fixture group missing");
    mdv.itemDefs.push({ oid: "IT.BMICAT", name: "BMI category", dataType: "text" });
    main.itemRefs.push({ itemOid: "IT.BMICAT", methodOid: "MET.BMICAT" });
    mdv.methodDefs.push({
      oid: "MET.BMICAT",
      name: "Category from BMI",
      type: "Computation",
      formalExpressions: [{ context: "jsonata", code: '`IT.BMI` >= 30 ? "obese" : "other"' }],
    });
    expect(errorsOf(mdv)).toEqual([]);
  });

  it("warns when a derived item is marked mandatory", () => {
    const mdv = fixtureMdv();
    const main = mdv.itemGroupDefs.find((g) => g.oid === "IG.MAIN");
    const ref = main?.itemRefs.find((r) => r.itemOid === "IT.BMI");
    if (!ref) throw new Error("fixture ref missing");
    ref.mandatory = "Yes";
    expect(warningsOf(mdv)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ItemGroupDef[IG.MAIN]",
          message: expect.stringContaining("IT.BMI"),
        }),
      ]),
    );
  });

  it("warns when a derivation reads a blinded item", () => {
    const mdv = fixtureMdv();
    const wt = mdv.itemDefs.find((i) => i.oid === "IT.WT");
    if (!wt) throw new Error("fixture item missing");
    wt.blinded = true;
    expect(warningsOf(mdv)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "MethodDef[MET.BMI]",
          message: expect.stringContaining("blind the derived item"),
        }),
      ]),
    );
  });

  it("warns when a collection exception reads a blinded item", () => {
    const mdv = fixtureMdv();
    const sex = mdv.itemDefs.find((i) => i.oid === "IT.SEX");
    if (!sex) throw new Error("fixture item missing");
    sex.blinded = true;
    const warnings = warningsOf(mdv);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ConditionDef[CD.MALE]",
          message: expect.stringContaining("visibility changes can reveal blinded values"),
        }),
      ]),
    );
  });
});
