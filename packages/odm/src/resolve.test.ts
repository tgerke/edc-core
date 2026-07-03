import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOdm } from "./index.js";
import { displayText, formsForEvent, listForms, resolveGroup } from "./resolve.js";

const fixtures = path.join(fileURLToPath(import.meta.url), "../../test/fixtures");
const file = parseOdm(readFileSync(path.join(fixtures, "cdisc-demographics-race.xml"), "utf8"));
const mdv = file.study?.metaDataVersions[0];
if (!mdv) throw new Error("fixture missing metadata version");

describe("listForms / formsForEvent", () => {
  it("identifies Type=Form item groups as forms", () => {
    expect(listForms(mdv).map((f) => f.oid)).toEqual(["FO.DEMOGRAPHICS"]);
  });

  it("resolves the forms referenced by an event", () => {
    expect(formsForEvent(mdv, "SE.SCREENING").map((f) => f.oid)).toEqual(["FO.DEMOGRAPHICS"]);
    expect(formsForEvent(mdv, "SE.NOPE")).toEqual([]);
  });
});

describe("resolveGroup", () => {
  const form = resolveGroup(mdv, "FO.DEMOGRAPHICS");

  it("builds the nested render tree", () => {
    expect(form?.def.oid).toBe("FO.DEMOGRAPHICS");
    const section = form?.children[0];
    if (section?.kind !== "group") throw new Error("expected nested section");
    expect(section.def.oid).toBe("IG.DEMOGRAPHICS");

    const itemOids = section.children
      .filter((c) => c.kind === "item")
      .map((c) => (c.kind === "item" ? c.def.oid : ""));
    expect(itemOids).toEqual(["IT.DOB", "IT.SEX", "IT.ETHNIC"]);

    const race = section.children.find((c) => c.kind === "group");
    if (race?.kind !== "group") throw new Error("expected race group");
    expect(race.def.repeating).toBe("Static");
  });

  it("attaches codelists to items", () => {
    const section = form?.children[0];
    if (section?.kind !== "group") throw new Error("expected nested section");
    const sex = section.children.find((c) => c.kind === "item" && c.def.oid === "IT.SEX");
    if (sex?.kind !== "item") throw new Error("expected item");
    expect(sex.codeList?.oid).toBe("CL.SEX");
    expect(sex.codeList?.items.map((i) => i.codedValue)).toEqual(["1", "2"]);
  });

  it("returns null for unknown groups", () => {
    expect(resolveGroup(mdv, "IG.UNKNOWN")).toBeNull();
  });
});

describe("displayText", () => {
  it("prefers English, falls back to first", () => {
    expect(
      displayText([
        { lang: "de", text: "Nein" },
        { lang: "en", text: "No" },
      ]),
    ).toBe("No");
    expect(displayText([{ lang: "de", text: "Nein" }])).toBe("Nein");
    expect(displayText([])).toBeUndefined();
  });
});
