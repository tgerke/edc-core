import { describe, expect, it } from "vitest";
import { parseOdm, serializeOdm } from "./index.js";
import { isOdm13Xml, upconvertOdm13Xml } from "./odm13.js";
import { validateMetaDataVersion } from "./validate.js";

/** Representative ODM 1.3.2 metadata document exercising the whole mapping. */
const ODM13 = `<?xml version="1.0" encoding="UTF-8"?>
<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3" FileOID="LEGACY.1" FileType="Snapshot"
     ODMVersion="1.3.2" CreationDateTime="2016-05-01T12:00:00Z" SourceSystem="LegacyEDC">
  <Study OID="ST.LEGACY">
    <GlobalVariables>
      <StudyName>Legacy Hypertension Study</StudyName>
      <StudyDescription>A legacy ODM 1.3.2 export.</StudyDescription>
      <ProtocolName>LEG-001</ProtocolName>
    </GlobalVariables>
    <BasicDefinitions>
      <MeasurementUnit OID="MU.MMHG" Name="mmHg">
        <Symbol><TranslatedText xml:lang="en">mmHg</TranslatedText></Symbol>
      </MeasurementUnit>
    </BasicDefinitions>
    <MetaDataVersion OID="MDV.1" Name="Version 1" Description="Initial legacy build">
      <Protocol>
        <StudyEventRef StudyEventOID="SE.BASELINE" OrderNumber="2" Mandatory="Yes"/>
        <StudyEventRef StudyEventOID="SE.SCREENING" OrderNumber="1" Mandatory="Yes"/>
      </Protocol>
      <StudyEventDef OID="SE.BASELINE" Name="Baseline" Repeating="No" Type="Scheduled">
        <FormRef FormOID="FO.VS" Mandatory="Yes" OrderNumber="1"/>
      </StudyEventDef>
      <StudyEventDef OID="SE.SCREENING" Name="Screening" Repeating="No" Type="Scheduled">
        <FormRef FormOID="FO.DM" Mandatory="Yes" OrderNumber="2"/>
        <FormRef FormOID="FO.VS" Mandatory="Yes" OrderNumber="1"/>
      </StudyEventDef>
      <FormDef OID="FO.DM" Name="Demographics" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.DM" Mandatory="Yes" OrderNumber="1"/>
      </FormDef>
      <FormDef OID="FO.VS" Name="Vital Signs" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes" OrderNumber="1"/>
        <ArchiveLayout OID="AL.1" PdfFileName="vs.pdf"/>
      </FormDef>
      <ItemGroupDef OID="IG.DM" Name="Demographics" Repeating="No" SASDatasetName="DM">
        <ItemRef ItemOID="IT.SEX" Mandatory="Yes" OrderNumber="2"/>
        <ItemRef ItemOID="IT.BRTHDTC" Mandatory="Yes" OrderNumber="1"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Vitals" Repeating="Yes" SASDatasetName="VS">
        <ItemRef ItemOID="IT.SYSBP" Mandatory="Yes" OrderNumber="1"/>
      </ItemGroupDef>
      <ItemDef OID="IT.BRTHDTC" Name="Birth date" DataType="date">
        <Question><TranslatedText xml:lang="en">Date of birth?</TranslatedText></Question>
      </ItemDef>
      <ItemDef OID="IT.SEX" Name="Sex" DataType="text" Length="1">
        <Question><TranslatedText xml:lang="en">Sex of the subject?</TranslatedText></Question>
        <CodeListRef CodeListOID="CL.SEX"/>
      </ItemDef>
      <ItemDef OID="IT.SYSBP" Name="Systolic BP" DataType="integer">
        <Question><TranslatedText xml:lang="en">Systolic blood pressure?</TranslatedText></Question>
        <MeasurementUnitRef MeasurementUnitOID="MU.MMHG"/>
        <RangeCheck Comparator="GE" SoftHard="Soft">
          <CheckValue>70</CheckValue>
        </RangeCheck>
      </ItemDef>
      <CodeList OID="CL.SEX" Name="Sex" DataType="text">
        <CodeListItem CodedValue="M">
          <Decode><TranslatedText xml:lang="en">Male</TranslatedText></Decode>
        </CodeListItem>
        <CodeListItem CodedValue="F">
          <Decode><TranslatedText xml:lang="en">Female</TranslatedText></Decode>
        </CodeListItem>
        <EnumeratedItem CodedValue="U"/>
      </CodeList>
      <ConditionDef OID="COND.BP" Name="BP plausibility">
        <Description><TranslatedText xml:lang="en">Systolic BP out of range</TranslatedText></Description>
        <FormalExpression Context="jsonata">\`IT.SYSBP\` != null and \`IT.SYSBP\` &lt; 70</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

describe("isOdm13Xml", () => {
  it("detects 1.3.x documents", () => {
    expect(isOdm13Xml(ODM13)).toBe(true);
    expect(isOdm13Xml(ODM13.replace('ODMVersion="1.3.2"', 'ODMVersion="1.3"'))).toBe(true);
    expect(isOdm13Xml(ODM13.replace('ODMVersion="1.3.2"', 'ODMVersion="2.0"'))).toBe(false);
    expect(isOdm13Xml("{}")).toBe(false);
  });
});

describe("upconvertOdm13Xml", () => {
  const { file, warnings } = upconvertOdm13Xml(ODM13);
  const mdv = file.study?.metaDataVersions[0];
  if (!mdv) throw new Error("no MetaDataVersion converted");

  it("maps GlobalVariables to Study attributes", () => {
    expect(file.study?.studyName).toBe("Legacy Hypertension Study");
    expect(file.study?.protocolName).toBe("LEG-001");
    expect(file.study?.description?.[0]?.text).toBe("A legacy ODM 1.3.2 export.");
    expect(file.odmVersion).toBe("2.0");
    expect(file.sourceSystem).toBe("LegacyEDC");
  });

  it("maps the MetaDataVersion Description attribute to an element", () => {
    expect(mdv.description?.[0]?.text).toBe("Initial legacy build");
  });

  it("converts FormDefs to ItemGroupDefs with Type=Form", () => {
    const forms = mdv.itemGroupDefs.filter((g) => g.type === "Form");
    expect(forms.map((f) => f.oid)).toEqual(["FO.DM", "FO.VS"]);
    expect(forms[0]?.itemGroupRefs).toEqual([
      { itemGroupOid: "IG.DM", mandatory: "Yes", orderNumber: 1 },
    ]);
  });

  it("rewrites event FormRefs as ItemGroupRefs in OrderNumber order", () => {
    const screening = mdv.studyEventDefs.find((e) => e.oid === "SE.SCREENING");
    expect(screening?.itemGroupRefs.map((r) => r.itemGroupOid)).toEqual(["FO.VS", "FO.DM"]);
  });

  it("orders events by the Protocol's StudyEventRefs", () => {
    expect(mdv.studyEventDefs.map((e) => e.oid)).toEqual(["SE.SCREENING", "SE.BASELINE"]);
  });

  it("orders item refs and keeps group attributes", () => {
    const dm = mdv.itemGroupDefs.find((g) => g.oid === "IG.DM");
    expect(dm?.itemRefs.map((r) => r.itemOid)).toEqual(["IT.BRTHDTC", "IT.SEX"]);
    expect(mdv.itemGroupDefs.find((g) => g.oid === "IG.VS")?.repeating).toBe("Yes");
  });

  it("keeps items, questions, codelists, and enumerated items", () => {
    const sex = mdv.itemDefs.find((i) => i.oid === "IT.SEX");
    expect(sex?.question?.[0]?.text).toBe("Sex of the subject?");
    expect(sex?.codeListRef?.codeListOid).toBe("CL.SEX");
    const cl = mdv.codeLists.find((c) => c.oid === "CL.SEX");
    expect(cl?.items.map((i) => i.codedValue)).toEqual(["M", "F", "U"]);
    expect(cl?.items[2]?.decode).toBeUndefined();
  });

  it("keeps ConditionDefs (edit checks survive the conversion)", () => {
    expect(mdv.conditionDefs[0]?.oid).toBe("COND.BP");
    expect(mdv.conditionDefs[0]?.formalExpressions[0]?.context).toBe("jsonata");
  });

  it("warns about every dropped construct", () => {
    const messages = warnings.map((w) => `${w.path}: ${w.message}`);
    expect(messages.some((m) => m.startsWith("ODM: converted from ODM 1.3.2"))).toBe(true);
    expect(messages.some((m) => m.includes("BasicDefinitions"))).toBe(true);
    expect(messages.some((m) => m.includes("RangeCheck"))).toBe(true);
    expect(messages.some((m) => m.includes("MeasurementUnitRef"))).toBe(true);
    expect(messages.some((m) => m.includes("ArchiveLayout"))).toBe(true);
  });

  it("produces a referentially valid build", () => {
    expect(validateMetaDataVersion(mdv).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("round-trips out as ODM v2.0", () => {
    const xml = serializeOdm(file, "xml");
    expect(xml).toContain('ODMVersion="2.0"');
    expect(xml).toContain('StudyName="Legacy Hypertension Study"');
    const reparsed = parseOdm(xml);
    expect(reparsed.study?.metaDataVersions[0]?.itemGroupDefs).toHaveLength(
      mdv.itemGroupDefs.length,
    );
  });
});

describe("upconvertOdm13Xml edge cases", () => {
  it("renames FormDef OIDs that collide with ItemGroupDef OIDs", () => {
    const colliding = ODM13.replace('FormDef OID="FO.DM"', 'FormDef OID="IG.DM"').replaceAll(
      'FormOID="FO.DM"',
      'FormOID="IG.DM"',
    );
    const { file, warnings } = upconvertOdm13Xml(colliding);
    const mdv = file.study?.metaDataVersions[0];
    if (!mdv) throw new Error("no MetaDataVersion converted");
    const forms = mdv.itemGroupDefs.filter((g) => g.type === "Form");
    expect(forms.map((f) => f.oid)).toContain("FO.IG.DM");
    const screening = mdv.studyEventDefs.find((e) => e.oid === "SE.SCREENING");
    expect(screening?.itemGroupRefs.map((r) => r.itemGroupOid)).toContain("FO.IG.DM");
    expect(warnings.some((w) => w.message.includes("collides"))).toBe(true);
    expect(validateMetaDataVersion(mdv).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("warns when the document embeds clinical data", () => {
    const withData = ODM13.replace(
      "</Study>",
      '</Study><ClinicalData StudyOID="ST.LEGACY" MetaDataVersionOID="MDV.1"/>',
    );
    const { warnings } = upconvertOdm13Xml(withData);
    expect(warnings.some((w) => w.path === "ClinicalData")).toBe(true);
  });

  it("rejects non-1.3 documents", () => {
    expect(() =>
      upconvertOdm13Xml(ODM13.replace('ODMVersion="1.3.2"', 'ODMVersion="1.2"')),
    ).toThrow(/not an ODM 1.3/);
  });
});

describe("parseOdm with 1.3 content", () => {
  it("upconverts transparently", () => {
    const file = parseOdm(ODM13);
    expect(file.odmVersion).toBe("2.0");
    expect(file.study?.metaDataVersions[0]?.itemGroupDefs.some((g) => g.type === "Form")).toBe(
      true,
    );
  });
});
