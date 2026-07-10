import { describe, expect, it } from "vitest";
import { diffMetaDataVersions } from "./diff.js";
import { updateItemDef } from "./edit.js";
import { parseOdm, serializeOdm } from "./index.js";
import { validateMetaDataVersion } from "./validate.js";

const XML = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
    FileOID="BLD" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-07-10T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.BLD" StudyName="Blinding Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.DA" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.DA" Name="Dosing" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.DA" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.DA" Name="Dose administration" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.DOSE" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.ROUTE" Mandatory="No"/>
      </ItemGroupDef>
      <ItemDef OID="IT.DOSE" Name="Dose (mg)" DataType="integer" edc:Blinded="Yes"/>
      <ItemDef OID="IT.ROUTE" Name="Route" DataType="text"/>
      <ConditionDef OID="CHK.DOSE" Name="Dose plausible">
        <Description><TranslatedText xml:lang="en" Type="text/plain">Dose outside the expected range.</TranslatedText></Description>
        <FormalExpression Context="jsonata">\`IT.DOSE\` != null and \`IT.DOSE\` &gt; 100</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

describe("blinded item flag (edc:Blinded vendor extension)", () => {
  const file = parseOdm(XML);
  const mdv = file.study?.metaDataVersions[0];
  if (!mdv) throw new Error("fixture has no metadata version");

  it("parses edc:Blinded into the typed model", () => {
    expect(mdv.itemDefs.find((i) => i.oid === "IT.DOSE")?.blinded).toBe(true);
    expect(mdv.itemDefs.find((i) => i.oid === "IT.ROUTE")?.blinded).toBeUndefined();
  });

  it("round-trips through XML with the namespace declared", () => {
    const xml = serializeOdm(file, "xml");
    expect(xml).toContain('edc:Blinded="Yes"');
    expect(xml).toContain('xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"');
    expect(parseOdm(xml)).toEqual(file);
  });

  it("round-trips through JSON", () => {
    expect(parseOdm(serializeOdm(file, "json"))).toEqual(file);
  });

  it("is toggled by updateItemDef and surfaces in the build diff", () => {
    const unblinded = updateItemDef(mdv, "IT.DOSE", { blinded: false });
    expect(unblinded.itemDefs.find((i) => i.oid === "IT.DOSE")?.blinded).toBeUndefined();

    const diff = diffMetaDataVersions(mdv, unblinded);
    const change = diff.items.find((i) => i.itemOid === "IT.DOSE");
    expect(change?.kind).toBe("changed");
    expect(change?.changes?.blinded).toEqual({ from: true, to: undefined });
  });

  it("warns when an edit check references a blinded item", () => {
    const warnings = validateMetaDataVersion(mdv).filter((i) => i.severity === "warning");
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ConditionDef[CHK.DOSE]",
          message: expect.stringContaining("IT.DOSE"),
        }),
      ]),
    );
  });
});
