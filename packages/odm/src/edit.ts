import type {
  ConditionDef,
  ItemDef,
  ItemGroupDef,
  MetaDataVersion,
  MethodDef,
  StudyEventDef,
  TranslatedText,
} from "./model.js";

/**
 * Pure, immutable edit operations over a MetaDataVersion — the engine behind
 * the point-and-click study builder. Every operation returns a new
 * MetaDataVersion; the UI accumulates edits in a draft and saves it through
 * the same versioned-metadata import path as file-driven builds (ADR-0003),
 * so edited builds are indistinguishable from imported ones downstream.
 *
 * Deletions cascade conservatively: removing a group deletes definitions that
 * became unreferenced *by that removal*, and never touches definitions that
 * were already unreferenced beforehand (legal ODM the author may want kept).
 */

/** Replace (or create) the entry `displayText` would show, preserving others. */
export function withDisplayText(
  texts: TranslatedText[] | undefined,
  value: string,
): TranslatedText[] {
  if (!texts || texts.length === 0) return [{ text: value }];
  const index = texts.findIndex((t) => t.lang?.startsWith("en"));
  const target = index >= 0 ? index : 0;
  return texts.map((t, i) => (i === target ? { ...t, text: value } : t));
}

function oidSlug(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "NEW";
}

/** Generate an OID unique within the collection, e.g. IT.PULSE, IT.PULSE_2. */
export function generateOid(existing: Iterable<string>, prefix: string, name: string): string {
  const taken = new Set(existing);
  const base = `${prefix}.${oidSlug(name)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function mustFindGroup(mdv: MetaDataVersion, groupOid: string): ItemGroupDef {
  const def = mdv.itemGroupDefs.find((g) => g.oid === groupOid);
  if (!def) throw new Error(`ItemGroupDef "${groupOid}" not found`);
  return def;
}

function replaceGroup(
  mdv: MetaDataVersion,
  groupOid: string,
  update: (group: ItemGroupDef) => ItemGroupDef,
): MetaDataVersion {
  mustFindGroup(mdv, groupOid);
  return {
    ...mdv,
    itemGroupDefs: mdv.itemGroupDefs.map((g) => (g.oid === groupOid ? update(g) : g)),
  };
}

export interface ItemDefPatch {
  name?: string;
  /** Display question text (the entry `displayText` shows). */
  question?: string;
  dataType?: string;
  /** null clears the length. */
  length?: number | null;
  /** null clears the codelist assignment. */
  codeListOid?: string | null;
  blinded?: boolean;
  /** null clears the coding-dictionary assignment. */
  codingDictionary?: "MedDRA" | "WHODrug" | null;
}

/** Item defs are shared: editing one changes every form that references it. */
export function updateItemDef(
  mdv: MetaDataVersion,
  itemOid: string,
  patch: ItemDefPatch,
): MetaDataVersion {
  if (!mdv.itemDefs.some((i) => i.oid === itemOid)) {
    throw new Error(`ItemDef "${itemOid}" not found`);
  }
  return {
    ...mdv,
    itemDefs: mdv.itemDefs.map((def) => {
      if (def.oid !== itemOid) return def;
      const next: ItemDef = { ...def };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.dataType !== undefined) next.dataType = patch.dataType;
      if (patch.question !== undefined)
        next.question = withDisplayText(def.question, patch.question);
      if (patch.length !== undefined) {
        if (patch.length === null) delete next.length;
        else next.length = patch.length;
      }
      if (patch.codeListOid !== undefined) {
        if (patch.codeListOid === null) delete next.codeListRef;
        else next.codeListRef = { codeListOid: patch.codeListOid };
      }
      if (patch.blinded !== undefined) {
        if (patch.blinded) next.blinded = true;
        else delete next.blinded;
      }
      if (patch.codingDictionary !== undefined) {
        if (patch.codingDictionary === null) delete next.codingDictionary;
        else next.codingDictionary = patch.codingDictionary;
      }
      return next;
    }),
  };
}

export function setItemMandatory(
  mdv: MetaDataVersion,
  groupOid: string,
  itemOid: string,
  mandatory: boolean,
): MetaDataVersion {
  return replaceGroup(mdv, groupOid, (group) => ({
    ...group,
    itemRefs: group.itemRefs.map((ref) =>
      ref.itemOid === itemOid ? { ...ref, mandatory: mandatory ? "Yes" : "No" } : ref,
    ),
  }));
}

export interface AddItemInit {
  name: string;
  dataType: string;
  question?: string;
  mandatory?: boolean;
}

/** Append a new item (def + ref) to a group. */
export function addItem(
  mdv: MetaDataVersion,
  groupOid: string,
  init: AddItemInit,
): { mdv: MetaDataVersion; itemOid: string } {
  const itemOid = generateOid(
    mdv.itemDefs.map((i) => i.oid),
    "IT",
    init.name,
  );
  const def: ItemDef = {
    oid: itemOid,
    name: init.name,
    dataType: init.dataType,
    ...(init.question !== undefined ? { question: [{ text: init.question }] } : {}),
  };
  let next: MetaDataVersion = { ...mdv, itemDefs: [...mdv.itemDefs, def] };
  next = replaceGroup(next, groupOid, (group) => ({
    ...group,
    itemRefs: [...group.itemRefs, { itemOid, mandatory: init.mandatory ? "Yes" : "No" }],
  }));
  return { mdv: next, itemOid };
}

/** Remove an item from a group; drop its def if nothing references it anymore. */
export function removeItem(
  mdv: MetaDataVersion,
  groupOid: string,
  itemOid: string,
): MetaDataVersion {
  const next = replaceGroup(mdv, groupOid, (group) => ({
    ...group,
    itemRefs: group.itemRefs.filter((ref) => ref.itemOid !== itemOid),
  }));
  const stillReferenced = next.itemGroupDefs.some((g) =>
    g.itemRefs.some((ref) => ref.itemOid === itemOid),
  );
  if (stillReferenced) return next;
  return { ...next, itemDefs: next.itemDefs.filter((i) => i.oid !== itemOid) };
}

/** Move an item up (-1) or down (+1) within its group; no-op at the edges. */
export function moveItem(
  mdv: MetaDataVersion,
  groupOid: string,
  itemOid: string,
  delta: -1 | 1,
): MetaDataVersion {
  return replaceGroup(mdv, groupOid, (group) => {
    const index = group.itemRefs.findIndex((ref) => ref.itemOid === itemOid);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= group.itemRefs.length) return group;
    const itemRefs = [...group.itemRefs];
    const [moved] = itemRefs.splice(index, 1);
    if (!moved) return group;
    itemRefs.splice(target, 0, moved);
    return { ...group, itemRefs };
  });
}

export interface ItemGroupPatch {
  name?: string;
  /** true → Repeating="Simple", false → "No". */
  repeating?: boolean;
}

export function updateItemGroup(
  mdv: MetaDataVersion,
  groupOid: string,
  patch: ItemGroupPatch,
): MetaDataVersion {
  return replaceGroup(mdv, groupOid, (group) => ({
    ...group,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.repeating !== undefined ? { repeating: patch.repeating ? "Simple" : "No" } : {}),
  }));
}

/** Add a form (ItemGroupDef Type="Form"), optionally scheduled into an event. */
export function addForm(
  mdv: MetaDataVersion,
  init: { name: string; eventOid?: string },
): { mdv: MetaDataVersion; formOid: string } {
  const formOid = generateOid(
    mdv.itemGroupDefs.map((g) => g.oid),
    "FO",
    init.name,
  );
  const def: ItemGroupDef = {
    oid: formOid,
    name: init.name,
    type: "Form",
    itemRefs: [],
    itemGroupRefs: [],
  };
  let next: MetaDataVersion = { ...mdv, itemGroupDefs: [...mdv.itemGroupDefs, def] };
  if (init.eventOid !== undefined) {
    const eventOid = init.eventOid;
    if (!next.studyEventDefs.some((e) => e.oid === eventOid)) {
      throw new Error(`StudyEventDef "${eventOid}" not found`);
    }
    next = {
      ...next,
      studyEventDefs: next.studyEventDefs.map((event) =>
        event.oid === eventOid
          ? { ...event, itemGroupRefs: [...event.itemGroupRefs, { itemGroupOid: formOid }] }
          : event,
      ),
    };
  }
  return { mdv: next, formOid };
}

/** Add a child item group (a form section) inside a form or group. */
export function addSection(
  mdv: MetaDataVersion,
  parentOid: string,
  init: { name: string; repeating?: boolean },
): { mdv: MetaDataVersion; groupOid: string } {
  const groupOid = generateOid(
    mdv.itemGroupDefs.map((g) => g.oid),
    "IG",
    init.name,
  );
  const def: ItemGroupDef = {
    oid: groupOid,
    name: init.name,
    ...(init.repeating ? { repeating: "Simple" } : {}),
    itemRefs: [],
    itemGroupRefs: [],
  };
  let next: MetaDataVersion = { ...mdv, itemGroupDefs: [...mdv.itemGroupDefs, def] };
  next = replaceGroup(next, parentOid, (parent) => ({
    ...parent,
    itemGroupRefs: [...parent.itemGroupRefs, { itemGroupOid: groupOid }],
  }));
  return { mdv: next, groupOid };
}

export function addEvent(
  mdv: MetaDataVersion,
  init: { name: string; repeating?: boolean },
): { mdv: MetaDataVersion; eventOid: string } {
  const eventOid = generateOid(
    mdv.studyEventDefs.map((e) => e.oid),
    "SE",
    init.name,
  );
  const def: StudyEventDef = {
    oid: eventOid,
    name: init.name,
    type: "Scheduled",
    ...(init.repeating ? { repeating: "Yes" } : {}),
    itemGroupRefs: [],
  };
  return { mdv: { ...mdv, studyEventDefs: [...mdv.studyEventDefs, def] }, eventOid };
}

function referencedGroupOids(mdv: MetaDataVersion): Set<string> {
  const referenced = new Set<string>();
  for (const event of mdv.studyEventDefs) {
    for (const ref of event.itemGroupRefs) referenced.add(ref.itemGroupOid);
  }
  for (const group of mdv.itemGroupDefs) {
    for (const ref of group.itemGroupRefs) referenced.add(ref.itemGroupOid);
  }
  return referenced;
}

/**
 * Delete a group (form or section) and every ref to it, cascading to
 * descendant groups/items that become unreferenced as a result.
 */
export function deleteGroup(mdv: MetaDataVersion, groupOid: string): MetaDataVersion {
  mustFindGroup(mdv, groupOid);

  // Descendants (candidates for cascade) before the deletion.
  const groupsByOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
  const descendantGroups = new Set<string>();
  const descendantItems = new Set<string>();
  const collect = (oid: string) => {
    const def = groupsByOid.get(oid);
    if (!def) return;
    for (const ref of def.itemRefs) descendantItems.add(ref.itemOid);
    for (const ref of def.itemGroupRefs) {
      if (!descendantGroups.has(ref.itemGroupOid)) {
        descendantGroups.add(ref.itemGroupOid);
        collect(ref.itemGroupOid);
      }
    }
  };
  collect(groupOid);

  // Remove the def and all refs to it.
  let next: MetaDataVersion = {
    ...mdv,
    studyEventDefs: mdv.studyEventDefs.map((event) => ({
      ...event,
      itemGroupRefs: event.itemGroupRefs.filter((ref) => ref.itemGroupOid !== groupOid),
    })),
    itemGroupDefs: mdv.itemGroupDefs
      .filter((g) => g.oid !== groupOid)
      .map((g) => ({
        ...g,
        itemGroupRefs: g.itemGroupRefs.filter((ref) => ref.itemGroupOid !== groupOid),
      })),
  };

  // Cascade: repeatedly drop descendant groups that lost their last reference.
  for (;;) {
    const referenced = referencedGroupOids(next);
    const orphans = next.itemGroupDefs.filter(
      (g) => descendantGroups.has(g.oid) && !referenced.has(g.oid),
    );
    if (orphans.length === 0) break;
    const orphanOids = new Set(orphans.map((g) => g.oid));
    for (const orphan of orphans) {
      for (const ref of orphan.itemRefs) descendantItems.add(ref.itemOid);
    }
    next = {
      ...next,
      itemGroupDefs: next.itemGroupDefs
        .filter((g) => !orphanOids.has(g.oid))
        .map((g) => ({
          ...g,
          itemGroupRefs: g.itemGroupRefs.filter((ref) => !orphanOids.has(ref.itemGroupOid)),
        })),
    };
  }

  // Drop descendant item defs that no remaining group references.
  const referencedItems = new Set<string>();
  for (const group of next.itemGroupDefs) {
    for (const ref of group.itemRefs) referencedItems.add(ref.itemOid);
  }
  return {
    ...next,
    itemDefs: next.itemDefs.filter(
      (i) => !descendantItems.has(i.oid) || referencedItems.has(i.oid),
    ),
  };
}

/** The jsonata FormalExpression code of a condition or method, if any. */
export function jsonataExpression(def: {
  formalExpressions: { context?: string | undefined; code: string }[];
}): string | undefined {
  return def.formalExpressions.find((e) => e.context === "jsonata")?.code;
}

/**
 * Replace (or create) the jsonata FormalExpression, preserving expressions
 * in other contexts (e.g. XPath from files authored elsewhere). null removes
 * the jsonata entry, making the construct inert at runtime.
 */
function withJsonataExpression(
  expressions: { context?: string | undefined; code: string }[],
  code: string | null,
): { context?: string | undefined; code: string }[] {
  const others = expressions.filter((e) => e.context !== "jsonata");
  if (code === null) return others;
  return [...others, { context: "jsonata", code }];
}

export interface RuleDefInit {
  name: string;
  /** jsonata FormalExpression code. */
  expression?: string;
  description?: string;
}

export interface RuleDefPatch {
  name?: string;
  /** Display description (the query message when the condition is an edit check). */
  description?: string;
  /** jsonata FormalExpression code; null removes it (other contexts are kept). */
  expression?: string | null;
}

/**
 * Add a ConditionDef. Its role follows from references: a condition wired as
 * a collection exception (item, group, or code list option) is skip logic;
 * an unreferenced condition runs as an edit check (true raises a query).
 */
export function addConditionDef(
  mdv: MetaDataVersion,
  init: RuleDefInit,
): { mdv: MetaDataVersion; conditionOid: string } {
  const conditionOid = generateOid(
    mdv.conditionDefs.map((c) => c.oid),
    "CD",
    init.name,
  );
  const def: ConditionDef = {
    oid: conditionOid,
    name: init.name,
    ...(init.description !== undefined ? { description: [{ text: init.description }] } : {}),
    formalExpressions:
      init.expression !== undefined ? [{ context: "jsonata", code: init.expression }] : [],
  };
  return { mdv: { ...mdv, conditionDefs: [...mdv.conditionDefs, def] }, conditionOid };
}

export function updateConditionDef(
  mdv: MetaDataVersion,
  conditionOid: string,
  patch: RuleDefPatch,
): MetaDataVersion {
  if (!mdv.conditionDefs.some((c) => c.oid === conditionOid)) {
    throw new Error(`ConditionDef "${conditionOid}" not found`);
  }
  return {
    ...mdv,
    conditionDefs: mdv.conditionDefs.map((def) => {
      if (def.oid !== conditionOid) return def;
      const next: ConditionDef = { ...def };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.description !== undefined)
        next.description = withDisplayText(def.description, patch.description);
      if (patch.expression !== undefined)
        next.formalExpressions = withJsonataExpression(def.formalExpressions, patch.expression);
      return next;
    }),
  };
}

/** Where a ConditionDef is referenced as a collection exception. */
export function conditionReferenceCount(mdv: MetaDataVersion, conditionOid: string): number {
  let count = 0;
  for (const event of mdv.studyEventDefs) {
    for (const ref of event.itemGroupRefs) {
      if (ref.collectionExceptionConditionOid === conditionOid) count++;
    }
  }
  for (const group of mdv.itemGroupDefs) {
    for (const ref of group.itemRefs) {
      if (ref.collectionExceptionConditionOid === conditionOid) count++;
    }
    for (const ref of group.itemGroupRefs) {
      if (ref.collectionExceptionConditionOid === conditionOid) count++;
    }
  }
  for (const codeList of mdv.codeLists) {
    for (const item of codeList.items) {
      if (item.collectionExceptionConditionOid === conditionOid) count++;
    }
  }
  return count;
}

/** Delete a ConditionDef; refuses while collection-exception refs point at it. */
export function removeConditionDef(mdv: MetaDataVersion, conditionOid: string): MetaDataVersion {
  if (!mdv.conditionDefs.some((c) => c.oid === conditionOid)) {
    throw new Error(`ConditionDef "${conditionOid}" not found`);
  }
  const refs = conditionReferenceCount(mdv, conditionOid);
  if (refs > 0) {
    throw new Error(`ConditionDef "${conditionOid}" is referenced ${refs} time(s)`);
  }
  return { ...mdv, conditionDefs: mdv.conditionDefs.filter((c) => c.oid !== conditionOid) };
}

/** Add a MethodDef (Type="Computation") for derived values. */
export function addMethodDef(
  mdv: MetaDataVersion,
  init: RuleDefInit,
): { mdv: MetaDataVersion; methodOid: string } {
  const methodOid = generateOid(
    mdv.methodDefs.map((m) => m.oid),
    "MET",
    init.name,
  );
  const def: MethodDef = {
    oid: methodOid,
    name: init.name,
    type: "Computation",
    ...(init.description !== undefined ? { description: [{ text: init.description }] } : {}),
    formalExpressions:
      init.expression !== undefined ? [{ context: "jsonata", code: init.expression }] : [],
  };
  return { mdv: { ...mdv, methodDefs: [...mdv.methodDefs, def] }, methodOid };
}

export function updateMethodDef(
  mdv: MetaDataVersion,
  methodOid: string,
  patch: RuleDefPatch,
): MetaDataVersion {
  if (!mdv.methodDefs.some((m) => m.oid === methodOid)) {
    throw new Error(`MethodDef "${methodOid}" not found`);
  }
  return {
    ...mdv,
    methodDefs: mdv.methodDefs.map((def) => {
      if (def.oid !== methodOid) return def;
      const next: MethodDef = { ...def };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.description !== undefined)
        next.description = withDisplayText(def.description, patch.description);
      if (patch.expression !== undefined)
        next.formalExpressions = withJsonataExpression(def.formalExpressions, patch.expression);
      return next;
    }),
  };
}

export function methodReferenceCount(mdv: MetaDataVersion, methodOid: string): number {
  let count = 0;
  for (const group of mdv.itemGroupDefs) {
    for (const ref of group.itemRefs) {
      if (ref.methodOid === methodOid) count++;
    }
  }
  return count;
}

/** Delete a MethodDef; refuses while ItemRefs point at it. */
export function removeMethodDef(mdv: MetaDataVersion, methodOid: string): MetaDataVersion {
  if (!mdv.methodDefs.some((m) => m.oid === methodOid)) {
    throw new Error(`MethodDef "${methodOid}" not found`);
  }
  const refs = methodReferenceCount(mdv, methodOid);
  if (refs > 0) {
    throw new Error(`MethodDef "${methodOid}" is referenced ${refs} time(s)`);
  }
  return { ...mdv, methodDefs: mdv.methodDefs.filter((m) => m.oid !== methodOid) };
}

function mustFindConditionDef(mdv: MetaDataVersion, conditionOid: string): void {
  if (!mdv.conditionDefs.some((c) => c.oid === conditionOid)) {
    throw new Error(`ConditionDef "${conditionOid}" not found`);
  }
}

/**
 * Set (or clear, with null) the skip condition on an item within a group:
 * the field is not collected when the condition evaluates true.
 */
export function setItemCollectionException(
  mdv: MetaDataVersion,
  groupOid: string,
  itemOid: string,
  conditionOid: string | null,
): MetaDataVersion {
  if (conditionOid !== null) mustFindConditionDef(mdv, conditionOid);
  return replaceGroup(mdv, groupOid, (group) => ({
    ...group,
    itemRefs: group.itemRefs.map((ref) => {
      if (ref.itemOid !== itemOid) return ref;
      if (conditionOid === null) {
        const { collectionExceptionConditionOid: _, ...rest } = ref;
        return rest;
      }
      return { ...ref, collectionExceptionConditionOid: conditionOid };
    }),
  }));
}

/**
 * Set (or clear, with null) the skip condition on a section's ref within its
 * parent group. Event-level refs are visit scheduling and are not authored
 * here (ADR-0014: not honored by form state).
 */
export function setGroupCollectionException(
  mdv: MetaDataVersion,
  parentOid: string,
  groupOid: string,
  conditionOid: string | null,
): MetaDataVersion {
  if (conditionOid !== null) mustFindConditionDef(mdv, conditionOid);
  return replaceGroup(mdv, parentOid, (parent) => ({
    ...parent,
    itemGroupRefs: parent.itemGroupRefs.map((ref) => {
      if (ref.itemGroupOid !== groupOid) return ref;
      if (conditionOid === null) {
        const { collectionExceptionConditionOid: _, ...rest } = ref;
        return rest;
      }
      return { ...ref, collectionExceptionConditionOid: conditionOid };
    }),
  }));
}

/**
 * Set (or clear, with null) the derivation method on an item within a group.
 * Derived items are system-written, so setting a method forces Mandatory="No"
 * (derived + mandatory is a publish-time validation error).
 */
export function setItemMethod(
  mdv: MetaDataVersion,
  groupOid: string,
  itemOid: string,
  methodOid: string | null,
): MetaDataVersion {
  if (methodOid !== null && !mdv.methodDefs.some((m) => m.oid === methodOid)) {
    throw new Error(`MethodDef "${methodOid}" not found`);
  }
  return replaceGroup(mdv, groupOid, (group) => ({
    ...group,
    itemRefs: group.itemRefs.map((ref) => {
      if (ref.itemOid !== itemOid) return ref;
      if (methodOid === null) {
        const { methodOid: _, ...rest } = ref;
        return rest;
      }
      return { ...ref, methodOid, mandatory: "No" };
    }),
  }));
}

/** A minimal single-visit, single-form definition to start a build from scratch. */
export function blankMetaDataVersion(studyName: string): MetaDataVersion {
  return {
    oid: "MDV.1",
    name: `${studyName} metadata`,
    studyEventDefs: [
      {
        oid: "SE.VISIT_1",
        name: "Visit 1",
        type: "Scheduled",
        itemGroupRefs: [{ itemGroupOid: "FO.NEW_FORM" }],
      },
    ],
    itemGroupDefs: [
      { oid: "FO.NEW_FORM", name: "New Form", type: "Form", itemRefs: [], itemGroupRefs: [] },
    ],
    itemDefs: [],
    codeLists: [],
    conditionDefs: [],
    methodDefs: [],
  };
}
