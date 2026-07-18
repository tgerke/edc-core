import { isUnresolvedItem } from "./ext.js";
import type { MetaDataVersion } from "./model.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

function checkDuplicates(issues: ValidationIssue[], kind: string, oids: string[]): void {
  const seen = new Set<string>();
  for (const oid of oids) {
    if (seen.has(oid)) {
      issues.push({ severity: "error", path: `${kind}[${oid}]`, message: `duplicate OID` });
    }
    seen.add(oid);
  }
}

/**
 * Referential integrity for a MetaDataVersion: every Ref resolves to a Def,
 * OIDs are unique per definition type, and definitions are reachable.
 * Unreachable defs are warnings (legal ODM, likely authoring mistakes).
 */
export function validateMetaDataVersion(mdv: MetaDataVersion): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const itemGroupOids = new Set(mdv.itemGroupDefs.map((d) => d.oid));
  const itemOids = new Set(mdv.itemDefs.map((d) => d.oid));
  const codeListOids = new Set(mdv.codeLists.map((d) => d.oid));
  const conditionOids = new Set(mdv.conditionDefs.map((d) => d.oid));
  const methodOids = new Set(mdv.methodDefs.map((d) => d.oid));

  checkDuplicates(
    issues,
    "StudyEventDef",
    mdv.studyEventDefs.map((d) => d.oid),
  );
  checkDuplicates(
    issues,
    "ItemGroupDef",
    mdv.itemGroupDefs.map((d) => d.oid),
  );
  checkDuplicates(
    issues,
    "ItemDef",
    mdv.itemDefs.map((d) => d.oid),
  );
  checkDuplicates(
    issues,
    "CodeList",
    mdv.codeLists.map((d) => d.oid),
  );

  const referencedItemGroups = new Set<string>();
  const referencedItems = new Set<string>();

  const checkItemGroupRefs = (
    refs: { itemGroupOid: string; collectionExceptionConditionOid?: string }[],
    from: string,
  ) => {
    for (const ref of refs) {
      referencedItemGroups.add(ref.itemGroupOid);
      if (!itemGroupOids.has(ref.itemGroupOid)) {
        issues.push({
          severity: "error",
          path: from,
          message: `ItemGroupRef → "${ref.itemGroupOid}" does not resolve to an ItemGroupDef`,
        });
      }
    }
  };

  for (const se of mdv.studyEventDefs) {
    checkItemGroupRefs(se.itemGroupRefs, `StudyEventDef[${se.oid}]`);
  }

  for (const ig of mdv.itemGroupDefs) {
    checkItemGroupRefs(ig.itemGroupRefs, `ItemGroupDef[${ig.oid}]`);
    for (const ref of ig.itemRefs) {
      referencedItems.add(ref.itemOid);
      if (!itemOids.has(ref.itemOid)) {
        issues.push({
          severity: "error",
          path: `ItemGroupDef[${ig.oid}]`,
          message: `ItemRef → "${ref.itemOid}" does not resolve to an ItemDef`,
        });
      }
      if (
        ref.collectionExceptionConditionOid &&
        !conditionOids.has(ref.collectionExceptionConditionOid)
      ) {
        issues.push({
          severity: "error",
          path: `ItemGroupDef[${ig.oid}]`,
          message: `CollectionExceptionConditionOID → "${ref.collectionExceptionConditionOid}" does not resolve to a ConditionDef`,
        });
      }
      if (ref.methodOid && !methodOids.has(ref.methodOid)) {
        issues.push({
          severity: "error",
          path: `ItemGroupDef[${ig.oid}]`,
          message: `MethodOID → "${ref.methodOid}" does not resolve to a MethodDef`,
        });
      }
    }
  }

  for (const item of mdv.itemDefs) {
    if (item.codeListRef && !codeListOids.has(item.codeListRef.codeListOid)) {
      issues.push({
        severity: "error",
        path: `ItemDef[${item.oid}]`,
        message: `CodeListRef → "${item.codeListRef.codeListOid}" does not resolve to a CodeList`,
      });
    }
  }

  // Cycles in nested item groups would make form rendering diverge.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const defsByOid = new Map(mdv.itemGroupDefs.map((d) => [d.oid, d]));
  const visit = (oid: string, trail: string[]): void => {
    if (visiting.has(oid)) {
      issues.push({
        severity: "error",
        path: `ItemGroupDef[${oid}]`,
        message: `circular ItemGroupRef chain: ${[...trail, oid].join(" → ")}`,
      });
      return;
    }
    if (visited.has(oid)) return;
    visiting.add(oid);
    for (const ref of defsByOid.get(oid)?.itemGroupRefs ?? []) {
      visit(ref.itemGroupOid, [...trail, oid]);
    }
    visiting.delete(oid);
    visited.add(oid);
  };
  for (const oid of itemGroupOids) visit(oid, []);

  for (const ig of mdv.itemGroupDefs) {
    if (!referencedItemGroups.has(ig.oid)) {
      issues.push({
        severity: "warning",
        path: `ItemGroupDef[${ig.oid}]`,
        message: "defined but never referenced",
      });
    }
  }
  for (const item of mdv.itemDefs) {
    if (!referencedItems.has(item.oid)) {
      issues.push({
        severity: "warning",
        path: `ItemDef[${item.oid}]`,
        message: "defined but never referenced",
      });
    }
  }

  // Edit checks referencing blinded items run for everyone; their message
  // text is shown to blinded roles too. Legal, but easy to leak through:
  // check-message wording must not reveal expected values, and non-blinded
  // items derived from blinded ones leak by construction.
  const blindedOids = new Set(mdv.itemDefs.filter((i) => i.blinded).map((i) => i.oid));
  if (blindedOids.size > 0) {
    for (const condition of mdv.conditionDefs) {
      const referenced = [...blindedOids].filter((oid) =>
        condition.formalExpressions.some((e) => e.code.includes(oid)),
      );
      if (referenced.length > 0) {
        issues.push({
          severity: "warning",
          path: `ConditionDef[${condition.oid}]`,
          message: `references blinded item${referenced.length === 1 ? "" : "s"} ${referenced.join(", ")}: ensure the check message does not reveal blinded values`,
        });
      }
    }
  }

  // Draft items from unresolved protocol concepts are review-workspace
  // artifacts; a published build must be capture-ready, so they hard-fail.
  for (const item of mdv.itemDefs) {
    if (isUnresolvedItem(item)) {
      issues.push({
        severity: "error",
        path: `ItemDef[${item.oid}]`,
        message:
          "is an unresolved protocol draft item: complete it in the protocol review before publishing",
      });
    }
  }

  // Coding surfaces show verbatim values to any data.code holder, so a
  // blinded coding target would bypass blinding; the coding service skips
  // such items entirely.
  for (const item of mdv.itemDefs) {
    if (!item.codingDictionary) continue;
    if (item.blinded) {
      issues.push({
        severity: "warning",
        path: `ItemDef[${item.oid}]`,
        message: "is both blinded and a coding target: blinded items are never codable",
      });
    }
    if (item.dataType !== "text") {
      issues.push({
        severity: "warning",
        path: `ItemDef[${item.oid}]`,
        message: `has CodingDictionary but DataType "${item.dataType}": verbatim coding targets are expected to be text`,
      });
    }
  }

  return issues;
}
