import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOdm } from "./index.js";
import type { MetaDataVersion } from "./model.js";
import {
  governedRequirements,
  LAYOUT_LOCKED_ATTR,
  resolveVariantForm,
  type SiteFormVariantDefinition,
  seedVariantDefinition,
  validateVariantCoverage,
} from "./variants.js";

const fixtures = path.join(fileURLToPath(import.meta.url), "../../test/fixtures");
const demo = readFileSync(path.join(fixtures, "../../../../examples/demo-study.xml"), "utf8");

function mdv(): MetaDataVersion {
  const parsed = parseOdm(demo).study?.metaDataVersions[0];
  if (!parsed) throw new Error("fixture has no MetaDataVersion");
  return structuredClone(parsed);
}

function errors(build: MetaDataVersion, definition: SiteFormVariantDefinition): string[] {
  return validateVariantCoverage(build, definition)
    .filter((i) => i.severity === "error")
    .map((i) => `${i.path}: ${i.message}`);
}

describe("governedRequirements", () => {
  it("lists every collected item per event with canonical location", () => {
    const requirements = governedRequirements(mdv());
    const screening = requirements.get("SE.SCREENING");
    expect(screening).toBeDefined();
    expect(screening?.length).toBeGreaterThan(0);
    for (const item of screening ?? []) {
      expect(item.formOid.startsWith("FO.")).toBe(true);
      expect(item.canonicalGroupOid.length).toBeGreaterThan(0);
    }
  });

  it("marks items in repeating groups", () => {
    const requirements = governedRequirements(mdv());
    const all = [...requirements.values()].flat();
    // The demo study's AE log is a repeating section.
    expect(all.some((item) => item.repeating)).toBe(true);
  });
});

describe("seedVariantDefinition and validateVariantCoverage", () => {
  it("a seeded variant is data-equivalent by construction", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    expect(errors(build, definition)).toEqual([]);
  });

  it("accepts pure reorder/regroup/relabel", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    const allRefs = definition.events[0]?.forms.flatMap((f) =>
      f.sections.flatMap((s) => s.itemRefs),
    );
    if (!allRefs || allRefs.length === 0) throw new Error("unreachable");
    // One combined workflow form, reversed order, relabeled first item.
    const merged: SiteFormVariantDefinition = {
      events: [
        {
          eventOid: "SE.SCREENING",
          forms: [
            {
              oid: "V.SCREENING_WORKFLOW",
              name: "Screening workflow",
              sections: [
                {
                  label: "As performed in clinic",
                  itemRefs: [...allRefs].reverse().map((ref, index) => ({
                    ...ref,
                    orderNumber: index + 1,
                    ...(index === 0 ? { displayLabel: "First thing we do" } : {}),
                  })),
                },
              ],
            },
          ],
        },
      ],
    };
    expect(errors(build, merged)).toEqual([]);
  });

  it("rejects omission", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    definition.events[0]?.forms[0]?.sections[0]?.itemRefs.pop();
    expect(errors(build, definition).some((e) => e.includes("missing from the variant"))).toBe(
      true,
    );
  });

  it("rejects addition of items the event does not collect", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    definition.events[0]?.forms[0]?.sections[0]?.itemRefs.push({
      itemOid: "IT.INVENTED",
      mandatory: false,
      orderNumber: 99,
    });
    expect(errors(build, definition).some((e) => e.includes("cannot add data"))).toBe(true);
  });

  it("rejects weakening a mandatory flag but allows strengthening", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    const refs = definition.events[0]?.forms.flatMap((f) => f.sections.flatMap((s) => s.itemRefs));
    const required = refs?.find((r) => r.mandatory);
    const optional = refs?.find((r) => !r.mandatory);
    if (!required || !optional) throw new Error("fixture lacks mandatory mix");
    required.mandatory = false;
    optional.mandatory = true;
    const found = errors(build, definition);
    expect(found.some((e) => e.includes("only strengthen"))).toBe(true);
    expect(found.filter((e) => e.includes("only strengthen"))).toHaveLength(1);
  });

  it("rejects duplicate items and unknown events", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    const section = definition.events[0]?.forms[0]?.sections[0];
    const first = section?.itemRefs[0];
    if (!section || !first) throw new Error("unreachable");
    section.itemRefs.push({ ...first, orderNumber: 99 });
    definition.events.push({
      eventOid: "SE.NOPE",
      forms: [{ oid: "V.NOPE", name: "Nope", sections: [{ itemRefs: [] }] }],
    });
    const found = errors(build, definition);
    expect(found.some((e) => e.includes("more than once in the variant"))).toBe(true);
    expect(found.some((e) => e.includes("does not exist in the build"))).toBe(true);
  });

  it("rejects variants on layout-locked events", () => {
    const build = mdv();
    const event = build.studyEventDefs.find((e) => e.oid === "SE.SCREENING");
    if (!event) throw new Error("unreachable");
    event.extra = { ...(event.extra ?? {}), [LAYOUT_LOCKED_ATTR]: "Yes" };
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    expect(errors(build, definition).some((e) => e.includes("locked"))).toBe(true);
  });
});

describe("resolveVariantForm", () => {
  it("renders the variant layout over build item defs with canonical group oids", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    const form = definition.events[0]?.forms[0];
    if (!form) throw new Error("unreachable");
    const resolved = resolveVariantForm(build, definition, form.oid);
    expect(resolved?.def.oid).toBe(form.oid);
    expect(resolved?.def.type).toBe("Form");

    const items = (resolved?.children ?? []).filter((c) => c.kind === "item");
    expect(items.length).toBe(form.sections[0]?.itemRefs.length);
    for (const item of items) {
      if (item.kind !== "item") continue;
      expect(item.canonicalGroupOid).toBeDefined();
      expect(build.itemDefs.some((d) => d.oid === item.def.oid)).toBe(true);
    }
  });

  it("applies display relabels without touching the build defs", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    const ref = definition.events[0]?.forms[0]?.sections[0]?.itemRefs[0];
    if (!ref) throw new Error("unreachable");
    ref.displayLabel = "Clinic wording";
    const resolved = resolveVariantForm(
      build,
      definition,
      definition.events[0]?.forms[0]?.oid ?? "",
    );
    const first = resolved?.children.find((c) => c.kind === "item");
    if (first?.kind !== "item") throw new Error("unreachable");
    expect(first.def.question?.[0]?.text).toBe("Clinic wording");
    const original = build.itemDefs.find((d) => d.oid === first.def.oid);
    expect(original?.question?.[0]?.text).not.toBe("Clinic wording");
  });

  it("returns null for unknown variant forms", () => {
    const build = mdv();
    const definition = seedVariantDefinition(build, ["SE.SCREENING"]);
    expect(resolveVariantForm(build, definition, "V.MISSING")).toBeNull();
  });
});
