import { z } from "zod";
import { protocolExt } from "./ext.js";
import type { ItemGroupDef, MetaDataVersion } from "./model.js";
import { formsForEvent, type ResolvedGroup, type ResolvedItem, resolveGroup } from "./resolve.js";
import type { ValidationIssue } from "./validate.js";

/**
 * Site form variants: the sponsor's published build defines WHAT data every
 * site collects (the governed requirements); an approved variant redefines
 * only HOW a site's forms present it — regrouping, reordering, relabeling
 * references to the same ItemDefs. Because a variant can only reference
 * build items, captured values are byte-identical in shape across sites
 * regardless of which layout collected them.
 */

/** StudyEventDef extension: sponsor prohibits site variants for this event. */
export const LAYOUT_LOCKED_ATTR = "@_edc:LayoutLocked";

export const variantItemRefSchema = z.object({
  itemOid: z.string().min(1),
  /** May strengthen (false→true) the governed flag, never weaken it. */
  mandatory: z.boolean(),
  orderNumber: z.number().int(),
  /** Presentation-only relabel; the canonical question stays in the build. */
  displayLabel: z.string().optional(),
});
export type VariantItemRef = z.infer<typeof variantItemRefSchema>;

export const variantSectionSchema = z.object({
  label: z.string().optional(),
  itemRefs: z.array(variantItemRefSchema),
});
export type VariantSection = z.infer<typeof variantSectionSchema>;

export const variantFormSchema = z.object({
  /** Variant-local namespace so instances are distinguishable from build forms. */
  oid: z.string().regex(/^V\./, "variant form OIDs use the V. namespace"),
  name: z.string().min(1),
  sections: z.array(variantSectionSchema).min(1),
});
export type VariantForm = z.infer<typeof variantFormSchema>;

export const variantEventSchema = z.object({
  eventOid: z.string().min(1),
  forms: z.array(variantFormSchema).min(1),
});
export type VariantEvent = z.infer<typeof variantEventSchema>;

/** Events not listed fall back to the sponsor's standard forms. */
export const siteFormVariantDefinitionSchema = z.object({
  events: z.array(variantEventSchema).min(1),
});
export type SiteFormVariantDefinition = z.infer<typeof siteFormVariantDefinitionSchema>;

export interface GovernedItem {
  itemOid: string;
  mandatory: boolean;
  /** Build form the item is collected under (canonical presentation). */
  formOid: string;
  /** Innermost build group holding the ItemRef — what capture writes key on. */
  canonicalGroupOid: string;
  /** Items inside repeating groups cannot be regrouped by variants. */
  repeating: boolean;
}

function collectItems(
  group: ResolvedGroup,
  formOid: string,
  repeating: boolean,
  out: GovernedItem[],
): void {
  const groupRepeating =
    repeating || (group.def.repeating !== undefined && group.def.repeating !== "No");
  for (const child of group.children) {
    if (child.kind === "item") {
      out.push({
        itemOid: child.def.oid,
        mandatory: child.ref.mandatory === "Yes",
        formOid,
        canonicalGroupOid: group.def.oid,
        repeating: groupRepeating,
      });
    } else {
      collectItems(child, formOid, groupRepeating, out);
    }
  }
}

/**
 * The governed data layer: for each event, every item the build collects
 * there, with its mandatory flag and canonical location. Computed from the
 * build itself, so it works for all build paths, protocol-derived or not.
 */
export function governedRequirements(mdv: MetaDataVersion): Map<string, GovernedItem[]> {
  const requirements = new Map<string, GovernedItem[]>();
  for (const event of mdv.studyEventDefs) {
    const items: GovernedItem[] = [];
    const seen = new Set<string>();
    for (const form of formsForEvent(mdv, event.oid)) {
      const resolved = resolveGroup(mdv, form.oid);
      if (!resolved) continue;
      const collected: GovernedItem[] = [];
      collectItems(resolved, form.oid, false, collected);
      for (const item of collected) {
        if (seen.has(item.itemOid)) continue;
        seen.add(item.itemOid);
        items.push(item);
      }
    }
    requirements.set(event.oid, items);
  }
  return requirements;
}

export function isLayoutLocked(mdv: MetaDataVersion, eventOid: string): boolean {
  const event = mdv.studyEventDefs.find((e) => e.oid === eventOid);
  return event ? protocolExt(event, LAYOUT_LOCKED_ATTR) === "Yes" : false;
}

/**
 * Data-equivalence validation for a variant against a build. A passing
 * variant is provably equivalent to the standard layout: per touched event
 * it covers exactly the governed items (nothing dropped, nothing invented),
 * only strengthens mandatory flags, keeps repeating-group items in their
 * canonical group, and never touches a layout-locked event. Sponsor
 * approval reviews workflow suitability; data integrity is enforced here.
 */
export function validateVariantCoverage(
  mdv: MetaDataVersion,
  definition: SiteFormVariantDefinition,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const requirements = governedRequirements(mdv);

  const seenEvents = new Set<string>();
  const seenFormOids = new Set<string>();

  for (const event of definition.events) {
    const at = `VariantEvent[${event.eventOid}]`;
    if (seenEvents.has(event.eventOid)) {
      issues.push({ severity: "error", path: at, message: "event listed more than once" });
      continue;
    }
    seenEvents.add(event.eventOid);

    const governed = requirements.get(event.eventOid);
    if (!governed) {
      issues.push({
        severity: "error",
        path: at,
        message: "event does not exist in the build",
      });
      continue;
    }
    if (isLayoutLocked(mdv, event.eventOid)) {
      issues.push({
        severity: "error",
        path: at,
        message: "the sponsor locked this event's layout; site variants are not permitted",
      });
      continue;
    }

    const governedByOid = new Map(governed.map((g) => [g.itemOid, g]));
    const referenced = new Map<string, VariantItemRef>();

    for (const form of event.forms) {
      if (seenFormOids.has(form.oid)) {
        issues.push({
          severity: "error",
          path: `${at}.${form.oid}`,
          message: "variant form OID reused",
        });
      }
      seenFormOids.add(form.oid);

      for (const section of form.sections) {
        for (const ref of section.itemRefs) {
          const from = `${at}.${form.oid}`;
          if (referenced.has(ref.itemOid)) {
            issues.push({
              severity: "error",
              path: from,
              message: `item "${ref.itemOid}" appears more than once in the variant`,
            });
            continue;
          }
          referenced.set(ref.itemOid, ref);

          const item = governedByOid.get(ref.itemOid);
          if (!item) {
            issues.push({
              severity: "error",
              path: from,
              message: `item "${ref.itemOid}" is not collected at this event: sites cannot add data (that is a sponsor amendment)`,
            });
            continue;
          }
          if (item.mandatory && !ref.mandatory) {
            issues.push({
              severity: "error",
              path: from,
              message: `item "${ref.itemOid}" is required by the build; a variant may only strengthen mandatory flags`,
            });
          }
          if (item.repeating) {
            issues.push({
              severity: "error",
              path: from,
              message: `item "${ref.itemOid}" belongs to repeating group "${item.canonicalGroupOid}", which variants cannot regroup`,
            });
          }
        }
      }
    }

    for (const item of governed) {
      if (item.repeating) continue;
      if (!referenced.has(item.itemOid)) {
        issues.push({
          severity: "error",
          path: at,
          message: `item "${item.itemOid}" is collected at this event but missing from the variant: nothing may silently disappear from site workflow`,
        });
      }
    }
  }

  return issues;
}

/** Variant forms replacing the standard layout at an event (empty = fallback). */
export function variantFormsForEvent(
  definition: SiteFormVariantDefinition,
  eventOid: string,
): VariantForm[] {
  return definition.events.find((e) => e.eventOid === eventOid)?.forms ?? [];
}

/**
 * Resolve a variant form into the same render-tree shape as resolveGroup,
 * so form entry needs no renderer changes. Each item carries its canonical
 * build group OID — value writes key on canonical OIDs, which is what keeps
 * the captured data shape identical across layouts.
 */
export function resolveVariantForm(
  mdv: MetaDataVersion,
  definition: SiteFormVariantDefinition,
  variantFormOid: string,
): ResolvedGroup | null {
  const requirements = governedRequirements(mdv);
  const itemsByOid = new Map(mdv.itemDefs.map((i) => [i.oid, i]));
  const codeListsByOid = new Map(mdv.codeLists.map((c) => [c.oid, c]));

  for (const event of definition.events) {
    const form = event.forms.find((f) => f.oid === variantFormOid);
    if (!form) continue;
    const governedByOid = new Map(
      (requirements.get(event.eventOid) ?? []).map((g) => [g.itemOid, g]),
    );

    const formDef: ItemGroupDef = {
      oid: form.oid,
      name: form.name,
      type: "Form",
      itemRefs: [],
      itemGroupRefs: [],
    };

    const children: ResolvedGroup["children"] = [];
    form.sections.forEach((section, index) => {
      const items: ResolvedItem[] = [...section.itemRefs]
        .sort((a, b) => a.orderNumber - b.orderNumber)
        .flatMap((ref) => {
          const def = itemsByOid.get(ref.itemOid);
          if (!def) return [];
          const displayDef = ref.displayLabel
            ? { ...def, question: [{ text: ref.displayLabel }] }
            : def;
          const codeList = def.codeListRef
            ? codeListsByOid.get(def.codeListRef.codeListOid)
            : undefined;
          const canonicalGroupOid = governedByOid.get(ref.itemOid)?.canonicalGroupOid;
          return [
            {
              kind: "item" as const,
              ref: { mandatory: ref.mandatory ? "Yes" : "No" },
              def: displayDef,
              ...(codeList ? { codeList } : {}),
              ...(canonicalGroupOid !== undefined ? { canonicalGroupOid } : {}),
            },
          ];
        });

      if (section.label !== undefined || form.sections.length > 1) {
        children.push({
          kind: "group",
          ref: {},
          def: {
            oid: `${form.oid}.S${index + 1}`,
            name: section.label ?? `Section ${index + 1}`,
            type: "Section",
            itemRefs: [],
            itemGroupRefs: [],
          },
          children: items,
        });
      } else {
        children.push(...items);
      }
    });

    return { kind: "group", ref: {}, def: formDef, children };
  }
  return null;
}

/**
 * Seed a variant from the sponsor's standard layout: one variant form per
 * build form at the event, sections mirroring the canonical grouping. The
 * template the site editor starts from — never a blank canvas.
 */
export function seedVariantDefinition(
  mdv: MetaDataVersion,
  eventOids: string[],
): SiteFormVariantDefinition {
  const requirements = governedRequirements(mdv);
  return {
    events: eventOids.map((eventOid) => {
      const governed = (requirements.get(eventOid) ?? []).filter((g) => !g.repeating);
      const byForm = new Map<string, GovernedItem[]>();
      for (const item of governed) {
        const list = byForm.get(item.formOid) ?? [];
        list.push(item);
        byForm.set(item.formOid, list);
      }
      return {
        eventOid,
        forms: [...byForm.entries()].map(([formOid, items]) => {
          const buildForm = mdv.itemGroupDefs.find((g) => g.oid === formOid);
          return {
            oid: `V.${eventOid.replace(/^SE\./, "")}_${formOid.replace(/^FO\./, "")}`,
            name: buildForm?.name ?? formOid,
            sections: [
              {
                itemRefs: items.map((item, index) => ({
                  itemOid: item.itemOid,
                  mandatory: item.mandatory,
                  orderNumber: index + 1,
                })),
              },
            ],
          };
        }),
      };
    }),
  };
}
