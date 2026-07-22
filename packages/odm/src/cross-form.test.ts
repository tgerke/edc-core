import { describe, expect, it } from "vitest";
import { parseOdm, serializeOdm } from "./index.js";
import { validateMetaDataVersion } from "./validate.js";

// Cross-form edit-check references (ADR-0015): `FORM_OID`.`ITEM_OID` reads
// another form of the same subject. FormalExpression stays free text, so no
// schema change is involved — these tests pin the validator rules and the
// round-trip fidelity of expressions using the convention.
const XML = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    FileOID="XF" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-07-21T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.XF" StudyName="Cross Form Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.DM" Mandatory="Yes"/>
        <ItemGroupRef ItemGroupOID="FO.AE" Mandatory="No"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.DM" Name="Demographics" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.DM" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.DM" Name="Demographics section" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.VISDT" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="FO.AE" Name="Adverse Events" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.AE" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.AE" Name="AE entries" Type="Section" Repeating="Simple">
        <ItemRef ItemOID="IT.AESTDT" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.VISDT" Name="Visit date" DataType="date"/>
      <ItemDef OID="IT.AESTDT" Name="AE onset date" DataType="date"/>
      <ConditionDef OID="CHECK.AE_BEFORE_VISIT" Name="AE onset before visit">
        <Description><TranslatedText xml:lang="en">AE onset date is before the visit date</TranslatedText></Description>
        <FormalExpression Context="jsonata">\`IT.AESTDT\` != null and \`IT.AESTDT\` &lt; \`FO.DM\`.\`IT.VISDT\`</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

function mdvOf(xml: string) {
  const file = parseOdm(xml);
  const mdv = file.study?.metaDataVersions[0];
  if (!mdv) throw new Error("fixture has no MetaDataVersion");
  return { file, mdv };
}

describe("cross-form check validation", () => {
  it("accepts a well-formed cross-form reference", () => {
    const { mdv } = mdvOf(XML);
    const crossFormIssues = validateMetaDataVersion(mdv).filter((i) =>
      i.message.includes("cross-form"),
    );
    expect(crossFormIssues).toEqual([]);
  });

  it("errors when a qualified item is not on the referenced form", () => {
    const { mdv } = mdvOf(XML.replace("`FO.DM`.`IT.VISDT`", "`FO.DM`.`IT.AESTDT`"));
    const issues = validateMetaDataVersion(mdv);
    expect(issues).toContainEqual({
      severity: "error",
      path: "ConditionDef[CHECK.AE_BEFORE_VISIT]",
      message: 'cross-form reference `FO.DM`.`IT.AESTDT`: "IT.AESTDT" is not an item on that form',
    });
  });

  it("warns when a cross-form check has no local item to home it", () => {
    const { mdv } = mdvOf(
      XML.replace(
        "`IT.AESTDT` != null and `IT.AESTDT` &lt; `FO.DM`.`IT.VISDT`",
        "`FO.DM`.`IT.VISDT` = null",
      ),
    );
    const issues = validateMetaDataVersion(mdv);
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        path: "ConditionDef[CHECK.AE_BEFORE_VISIT]",
        message: expect.stringContaining("no unqualified local item reference"),
      }),
    );
  });

  it("allows instance-metadata references under the qualifier", () => {
    const { mdv } = mdvOf(XML.replace("`FO.DM`.`IT.VISDT`", "`FO.DM`.`_event_oid`"));
    const errors = validateMetaDataVersion(mdv).filter(
      (i) => i.severity === "error" && i.message.includes("cross-form"),
    );
    expect(errors).toEqual([]);
  });
});

describe("cross-form expression round-trip", () => {
  it("serializes the expression unchanged through XML and JSON", () => {
    const { file, mdv } = mdvOf(XML);
    const expression = mdv.conditionDefs[0]?.formalExpressions[0]?.code;
    expect(expression).toBe("`IT.AESTDT` != null and `IT.AESTDT` < `FO.DM`.`IT.VISDT`");

    const xmlAgain = mdvOf(serializeOdm(file, "xml")).mdv;
    expect(xmlAgain.conditionDefs[0]?.formalExpressions[0]?.code).toBe(expression);

    const jsonAgain = parseOdm(serializeOdm(file, "json"));
    expect(jsonAgain).toEqual(file);
  });
});
