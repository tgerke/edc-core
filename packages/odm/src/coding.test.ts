import { describe, expect, it } from "vitest";
import { diffMetaDataVersions } from "./diff.js";
import { updateItemDef } from "./edit.js";
import { parseOdm, serializeOdm } from "./index.js";
import { validateMetaDataVersion } from "./validate.js";

const XML = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
    FileOID="COD" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-07-10T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.COD" StudyName="Coding Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.AE" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.AE" Name="Adverse Events" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.AE" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.AE" Name="Adverse event" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.AETERM" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.CMTRT" Mandatory="No"/>
        <ItemRef ItemOID="IT.BAD" Mandatory="No"/>
        <ItemRef ItemOID="IT.SECRET" Mandatory="No"/>
        <ItemRef ItemOID="IT.COUNT" Mandatory="No"/>
      </ItemGroupDef>
      <ItemDef OID="IT.AETERM" Name="Reported Term" DataType="text" edc:CodingDictionary="MedDRA"/>
      <ItemDef OID="IT.CMTRT" Name="Medication Name" DataType="text" edc:CodingDictionary="WHODrug"/>
      <ItemDef OID="IT.BAD" Name="Typo Target" DataType="text" edc:CodingDictionary="MeDRA"/>
      <ItemDef OID="IT.SECRET" Name="Blinded Term" DataType="text" edc:Blinded="Yes" edc:CodingDictionary="MedDRA"/>
      <ItemDef OID="IT.COUNT" Name="Count" DataType="integer" edc:CodingDictionary="MedDRA"/>
    </MetaDataVersion>
  </Study>
</ODM>`;

describe("coding target flag (edc:CodingDictionary vendor extension)", () => {
  const file = parseOdm(XML);
  const mdv = file.study?.metaDataVersions[0];
  if (!mdv) throw new Error("fixture has no metadata version");
  const item = (oid: string) => mdv.itemDefs.find((i) => i.oid === oid);

  it("parses valid dictionary names into the typed model", () => {
    expect(item("IT.AETERM")?.codingDictionary).toBe("MedDRA");
    expect(item("IT.CMTRT")?.codingDictionary).toBe("WHODrug");
  });

  it("leaves invalid values in extra instead of dropping them", () => {
    const bad = item("IT.BAD");
    expect(bad?.codingDictionary).toBeUndefined();
    expect(JSON.stringify(bad?.extra)).toContain("MeDRA");
    const xml = serializeOdm(file, "xml");
    expect(xml).toContain('edc:CodingDictionary="MeDRA"');
  });

  it("round-trips through XML and JSON", () => {
    const xml = serializeOdm(file, "xml");
    expect(xml).toContain('edc:CodingDictionary="MedDRA"');
    expect(xml).toContain('edc:CodingDictionary="WHODrug"');
    expect(parseOdm(xml)).toEqual(file);
    expect(parseOdm(serializeOdm(file, "json"))).toEqual(file);
  });

  it("coexists with edc:Blinded on the same item", () => {
    expect(item("IT.SECRET")?.blinded).toBe(true);
    expect(item("IT.SECRET")?.codingDictionary).toBe("MedDRA");
  });

  it("is set and cleared by updateItemDef and surfaces in the build diff", () => {
    const cleared = updateItemDef(mdv, "IT.AETERM", { codingDictionary: null });
    expect(cleared.itemDefs.find((i) => i.oid === "IT.AETERM")?.codingDictionary).toBeUndefined();

    const diff = diffMetaDataVersions(mdv, cleared);
    const change = diff.items.find((i) => i.itemOid === "IT.AETERM");
    expect(change?.kind).toBe("changed");
    expect(change?.changes?.codingDictionary).toEqual({ from: "MedDRA", to: undefined });
  });

  it("warns on blinded coding targets and non-text coding targets", () => {
    const warnings = validateMetaDataVersion(mdv).filter((i) => i.severity === "warning");
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ItemDef[IT.SECRET]",
          message: expect.stringContaining("never codable"),
        }),
        expect.objectContaining({
          path: "ItemDef[IT.COUNT]",
          message: expect.stringContaining('DataType "integer"'),
        }),
      ]),
    );
  });
});
