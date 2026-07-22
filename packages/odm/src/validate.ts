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
  // ConditionDefs referenced as collection exceptions (item, group, or code
  // list option level) and MethodDefs referenced by ItemRefs: these must be
  // evaluable at runtime, so they get stricter checks below.
  const cecReferencedOids = new Set<string>();
  const methodReferencedOids = new Set<string>();

  const checkItemGroupRefs = (
    refs: { itemGroupOid: string; collectionExceptionConditionOid?: string | undefined }[],
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
      if (ref.collectionExceptionConditionOid) {
        cecReferencedOids.add(ref.collectionExceptionConditionOid);
        if (!conditionOids.has(ref.collectionExceptionConditionOid)) {
          issues.push({
            severity: "error",
            path: from,
            message: `CollectionExceptionConditionOID → "${ref.collectionExceptionConditionOid}" does not resolve to a ConditionDef`,
          });
        }
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
      if (ref.collectionExceptionConditionOid) {
        cecReferencedOids.add(ref.collectionExceptionConditionOid);
        if (!conditionOids.has(ref.collectionExceptionConditionOid)) {
          issues.push({
            severity: "error",
            path: `ItemGroupDef[${ig.oid}]`,
            message: `CollectionExceptionConditionOID → "${ref.collectionExceptionConditionOid}" does not resolve to a ConditionDef`,
          });
        }
      }
      if (ref.methodOid) {
        methodReferencedOids.add(ref.methodOid);
        if (!methodOids.has(ref.methodOid)) {
          issues.push({
            severity: "error",
            path: `ItemGroupDef[${ig.oid}]`,
            message: `MethodOID → "${ref.methodOid}" does not resolve to a MethodDef`,
          });
        }
        if (ref.mandatory === "Yes") {
          issues.push({
            severity: "warning",
            path: `ItemGroupDef[${ig.oid}]`,
            message: `ItemRef → "${ref.itemOid}" is derived (MethodOID) but Mandatory="Yes": derived items are system-written and cannot be entered`,
          });
        }
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

  for (const cl of mdv.codeLists) {
    for (const clItem of cl.items) {
      if (!clItem.collectionExceptionConditionOid) continue;
      cecReferencedOids.add(clItem.collectionExceptionConditionOid);
      if (!conditionOids.has(clItem.collectionExceptionConditionOid)) {
        issues.push({
          severity: "error",
          path: `CodeList[${cl.oid}]`,
          message: `CodeListItem[${clItem.codedValue}] CollectionExceptionConditionOID → "${clItem.collectionExceptionConditionOid}" does not resolve to a ConditionDef`,
        });
      }
    }
  }

  // Collection exceptions and derivations only execute when they carry a
  // jsonata expression. Files authored elsewhere (e.g. CDISC examples with
  // XPath expressions) must still import, so an unevaluable construct is a
  // warning: the field is simply always collected / never computed.
  const jsonataExpression = (def: {
    formalExpressions: { context?: string | undefined; code: string }[];
  }) => def.formalExpressions.find((e) => e.context === "jsonata")?.code;
  for (const condition of mdv.conditionDefs) {
    if (cecReferencedOids.has(condition.oid) && jsonataExpression(condition) === undefined) {
      issues.push({
        severity: "warning",
        path: `ConditionDef[${condition.oid}]`,
        message:
          "is referenced as a collection exception but has no jsonata FormalExpression: the exception will not be enforced at runtime",
      });
    }
  }
  for (const method of mdv.methodDefs) {
    if (methodReferencedOids.has(method.oid) && jsonataExpression(method) === undefined) {
      issues.push({
        severity: "warning",
        path: `MethodDef[${method.oid}]`,
        message:
          "is referenced by an ItemRef but has no jsonata FormalExpression: the derived value will never compute",
      });
    }
  }

  // A derivation chain that feeds itself can never settle; the runtime drops
  // cyclic derivations defensively, so surface the cycle at publish time.
  // Dependencies are found by scanning expressions for backtick-quoted OIDs
  // of other derived items (the ADR-0007 referencing convention).
  const methodsByOid = new Map(mdv.methodDefs.map((m) => [m.oid, m]));
  const derivedExpressions = new Map<string, string[]>();
  for (const ig of mdv.itemGroupDefs) {
    for (const ref of ig.itemRefs) {
      if (!ref.methodOid) continue;
      const method = methodsByOid.get(ref.methodOid);
      const code = method ? jsonataExpression(method) : undefined;
      if (code === undefined) continue;
      derivedExpressions.set(ref.itemOid, [...(derivedExpressions.get(ref.itemOid) ?? []), code]);
    }
  }
  const derivedDeps = new Map<string, string[]>();
  for (const [itemOid, codes] of derivedExpressions) {
    derivedDeps.set(
      itemOid,
      [...derivedExpressions.keys()].filter(
        (oid) => oid !== itemOid && codes.some((code) => code.includes(oid)),
      ),
    );
  }
  {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visitDerived = (oid: string, trail: string[]): void => {
      if (visiting.has(oid)) {
        issues.push({
          severity: "error",
          path: `ItemDef[${oid}]`,
          message: `circular derivation chain: ${[...trail, oid].join(" → ")}`,
        });
        return;
      }
      if (done.has(oid)) return;
      visiting.add(oid);
      for (const dep of derivedDeps.get(oid) ?? []) visitDerived(dep, [...trail, oid]);
      visiting.delete(oid);
      done.add(oid);
    };
    for (const oid of derivedDeps.keys()) visitDerived(oid, []);
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
    const blindedIn = (def: { formalExpressions: { code: string }[] }) =>
      [...blindedOids].filter((oid) => def.formalExpressions.some((e) => e.code.includes(oid)));
    for (const condition of mdv.conditionDefs) {
      const referenced = blindedIn(condition);
      if (referenced.length === 0) continue;
      const plural = referenced.length === 1 ? "" : "s";
      // Collection exceptions leak differently from edit checks: toggling a
      // field's visibility on a blinded value reveals that value to anyone
      // watching the form, regardless of message wording.
      issues.push({
        severity: "warning",
        path: `ConditionDef[${condition.oid}]`,
        message: cecReferencedOids.has(condition.oid)
          ? `collection exception references blinded item${plural} ${referenced.join(", ")}: visibility changes can reveal blinded values to blinded roles`
          : `references blinded item${plural} ${referenced.join(", ")}: ensure the check message does not reveal blinded values`,
      });
    }
    for (const method of mdv.methodDefs) {
      if (!methodReferencedOids.has(method.oid)) continue;
      const referenced = blindedIn(method);
      if (referenced.length === 0) continue;
      issues.push({
        severity: "warning",
        path: `MethodDef[${method.oid}]`,
        message: `derives from blinded item${referenced.length === 1 ? "" : "s"} ${referenced.join(", ")}: a non-blinded derived item leaks blinded data — blind the derived item too`,
      });
    }
  }

  // Cross-form check references (ADR-0015): an edit-check expression may
  // read another form of the same subject as `FORM_OID`.`ITEM_OID`. The
  // qualified item must exist on that form; a cross-form check with no
  // unqualified local item reference evaluates identically on every form
  // (no home to attribute its query to), which is almost never intended.
  {
    const escape = (oid: string) => oid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const groupsByOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
    const itemsReachableFrom = (rootOid: string): Set<string> => {
      const found = new Set<string>();
      const seen = new Set<string>();
      const queue = [rootOid];
      while (queue.length > 0) {
        const current = queue.pop();
        if (current === undefined || seen.has(current)) continue;
        seen.add(current);
        const group = groupsByOid.get(current);
        if (!group) continue;
        for (const ref of group.itemRefs) found.add(ref.itemOid);
        for (const ref of group.itemGroupRefs) queue.push(ref.itemGroupOid);
      }
      return found;
    };
    const formOids = mdv.itemGroupDefs.filter((g) => g.type === "Form").map((g) => g.oid);
    for (const condition of mdv.conditionDefs) {
      // Collection exceptions and dependent options are single-form runtime
      // constructs; cross-form syntax in them is not honored.
      if (cecReferencedOids.has(condition.oid)) continue;
      const code = jsonataExpression(condition);
      if (code === undefined) continue;
      const referencedForms = formOids.filter((oid) => code.includes(`\`${oid}\``));
      if (referencedForms.length === 0) continue;

      let stripped = code;
      for (const formOid of referencedForms) {
        const items = itemsReachableFrom(formOid);
        const qualified = new RegExp(`\`${escape(formOid)}\`\\s*\\.\\s*\`([^\`]+)\``, "g");
        for (const match of code.matchAll(qualified)) {
          const itemOid = match[1];
          if (itemOid !== undefined && !itemOid.startsWith("_") && !items.has(itemOid)) {
            issues.push({
              severity: "error",
              path: `ConditionDef[${condition.oid}]`,
              message: `cross-form reference \`${formOid}\`.\`${itemOid}\`: "${itemOid}" is not an item on that form`,
            });
          }
        }
        stripped = stripped
          .replaceAll(qualified, " ")
          .replaceAll(new RegExp(`\`${escape(formOid)}\``, "g"), " ");
      }
      const hasLocalItem = [...itemOids].some((oid) => stripped.includes(oid));
      if (!hasLocalItem) {
        issues.push({
          severity: "warning",
          path: `ConditionDef[${condition.oid}]`,
          message:
            "cross-form check has no unqualified local item reference: it will evaluate the same way on every form and cannot be attributed to a home form",
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
