import { describe, expect, it } from "vitest";
import { diffMetaDataVersions } from "./diff.js";
import { updateItemDef } from "./edit.js";
import { parseOdm, serializeOdm } from "./index.js";
import { validateMetaDataVersion } from "./validate.js";

// One clean designation (SE.V1 → IT.VISDT) plus the three ADR-0017 build
// pathologies: a text-typed designation, a blinded designation, and an
// event whose forms reach two designated items.
const XML = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
    FileOID="VD" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-08-10T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.VD" StudyName="Visit Date Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VISIT" Mandatory="Yes"/>
      </StudyEventDef>
      <StudyEventDef OID="SE.AMBIG" Name="Ambiguous Visit" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VISIT" Mandatory="Yes"/>
        <ItemGroupRef ItemGroupOID="FO.OTHER" Mandatory="No"/>
      </StudyEventDef>
      <StudyEventDef OID="SE.BADTYPES" Name="Bad Types Visit" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.BADTYPES" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VISIT" Name="Visit Form" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VISIT" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VISIT" Name="Visit Details" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.VISDT" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="FO.OTHER" Name="Other Form" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.OTHER" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.OTHER" Name="Other Details" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.VISDT2" Mandatory="No"/>
      </ItemGroupDef>
      <ItemGroupDef OID="FO.BADTYPES" Name="Bad Types Form" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.BADTYPES" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.BADTYPES" Name="Bad Types" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.TEXTDT" Mandatory="No"/>
        <ItemRef ItemOID="IT.SECRETDT" Mandatory="No"/>
      </ItemGroupDef>
      <ItemDef OID="IT.VISDT" Name="Visit Date" DataType="date" edc:VisitDate="Yes"/>
      <ItemDef OID="IT.VISDT2" Name="Alternate Visit Date" DataType="date" edc:VisitDate="Yes"/>
      <ItemDef OID="IT.TEXTDT" Name="Text Date" DataType="text" edc:VisitDate="Yes"/>
      <ItemDef OID="IT.SECRETDT" Name="Blinded Date" DataType="date" edc:Blinded="Yes" edc:VisitDate="Yes"/>
    </MetaDataVersion>
  </Study>
</ODM>`;

describe("visit date flag (edc:VisitDate vendor extension, ADR-0017)", () => {
  const file = parseOdm(XML);
  const mdv = file.study?.metaDataVersions[0];
  if (!mdv) throw new Error("fixture has no metadata version");
  const item = (oid: string) => mdv.itemDefs.find((i) => i.oid === oid);

  it("parses the designation into the typed model", () => {
    expect(item("IT.VISDT")?.visitDate).toBe(true);
    expect(item("IT.VISDT")?.dataType).toBe("date");
  });

  it("round-trips through XML and JSON", () => {
    const xml = serializeOdm(file, "xml");
    expect(xml).toContain('edc:VisitDate="Yes"');
    expect(parseOdm(xml)).toEqual(file);
    expect(parseOdm(serializeOdm(file, "json"))).toEqual(file);
  });

  it("hard-fails a designation that is not DataType date", () => {
    const errors = validateMetaDataVersion(mdv).filter((i) => i.severity === "error");
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ItemDef[IT.TEXTDT]",
          message: expect.stringContaining('DataType "text"'),
        }),
      ]),
    );
  });

  it("hard-fails a blinded designation", () => {
    const errors = validateMetaDataVersion(mdv).filter((i) => i.severity === "error");
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ItemDef[IT.SECRETDT]",
          message: expect.stringContaining("blinded"),
        }),
      ]),
    );
  });

  it("hard-fails an event whose forms reach two designated items", () => {
    const errors = validateMetaDataVersion(mdv).filter((i) => i.severity === "error");
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "StudyEventDef[SE.AMBIG]",
          message: expect.stringContaining("IT.VISDT, IT.VISDT2"),
        }),
      ]),
    );
    // The clean single-designation event raises nothing.
    expect(validateMetaDataVersion(mdv).filter((i) => i.path === "StudyEventDef[SE.V1]")).toEqual(
      [],
    );
  });

  it("is set and cleared by updateItemDef and surfaces in the build diff", () => {
    const cleared = updateItemDef(mdv, "IT.VISDT", { visitDate: false });
    expect(cleared.itemDefs.find((i) => i.oid === "IT.VISDT")?.visitDate).toBeUndefined();

    const diff = diffMetaDataVersions(mdv, cleared);
    const change = diff.items.find((i) => i.itemOid === "IT.VISDT");
    expect(change?.kind).toBe("changed");
    expect(change?.changes?.visitDate).toEqual({ from: true, to: undefined });
  });
});
