import type { CodeList, ItemDef, ItemGroupDef, MetaDataVersion } from "./model.js";

/**
 * Resolution helpers shared by the study builder UI and (later) the capture
 * forms engine: turn the flat, ref-based MetaDataVersion into render trees.
 */

export interface ResolvedItem {
  kind: "item";
  ref: { mandatory?: string; repeat?: string; other?: string };
  def: ItemDef;
  codeList?: CodeList;
  /**
   * Set when rendering a site form variant: the build group value writes key
   * on (the variant's own section grouping is presentation-only).
   */
  canonicalGroupOid?: string;
}

export interface ResolvedGroup {
  kind: "group";
  ref: { mandatory?: string };
  def: ItemGroupDef;
  children: (ResolvedItem | ResolvedGroup)[];
}

/** Forms are ItemGroupDefs with Type="Form" (ODM v2.0 has no FormDef). */
export function listForms(mdv: MetaDataVersion): ItemGroupDef[] {
  return mdv.itemGroupDefs.filter((g) => g.type === "Form");
}

/** Events reference forms directly through their ItemGroupRefs. */
export function formsForEvent(mdv: MetaDataVersion, eventOid: string): ItemGroupDef[] {
  const event = mdv.studyEventDefs.find((e) => e.oid === eventOid);
  if (!event) return [];
  const byOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
  return event.itemGroupRefs
    .map((ref) => byOid.get(ref.itemGroupOid))
    .filter((g): g is ItemGroupDef => g !== undefined);
}

/**
 * Resolve a form (or any item group) into its render tree. Cycles are
 * guarded against defensively even though the validator rejects them.
 */
export function resolveGroup(mdv: MetaDataVersion, groupOid: string): ResolvedGroup | null {
  const groupsByOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
  const itemsByOid = new Map(mdv.itemDefs.map((i) => [i.oid, i]));
  const codeListsByOid = new Map(mdv.codeLists.map((c) => [c.oid, c]));

  const walk = (oid: string, seen: Set<string>): ResolvedGroup | null => {
    const def = groupsByOid.get(oid);
    if (!def || seen.has(oid)) return null;
    const nextSeen = new Set(seen).add(oid);

    const children: (ResolvedItem | ResolvedGroup)[] = [];
    for (const ref of def.itemRefs) {
      const itemDef = itemsByOid.get(ref.itemOid);
      if (!itemDef) continue;
      const codeList = itemDef.codeListRef
        ? codeListsByOid.get(itemDef.codeListRef.codeListOid)
        : undefined;
      children.push({
        kind: "item",
        ref: {
          ...(ref.mandatory !== undefined ? { mandatory: ref.mandatory } : {}),
          ...(ref.repeat !== undefined ? { repeat: ref.repeat } : {}),
          ...(ref.other !== undefined ? { other: ref.other } : {}),
        },
        def: itemDef,
        ...(codeList ? { codeList } : {}),
      });
    }
    for (const ref of def.itemGroupRefs) {
      const child = walk(ref.itemGroupOid, nextSeen);
      if (child) {
        children.push({
          ...child,
          ref: { ...(ref.mandatory !== undefined ? { mandatory: ref.mandatory } : {}) },
        });
      }
    }

    return { kind: "group", ref: {}, def, children };
  };

  return walk(groupOid, new Set());
}

/** Preferred display text: first English entry, else the first available. */
export function displayText(
  texts: { lang?: string | undefined; text: string }[] | undefined,
): string | undefined {
  if (!texts || texts.length === 0) return undefined;
  return (texts.find((t) => t.lang?.startsWith("en")) ?? texts[0])?.text;
}
