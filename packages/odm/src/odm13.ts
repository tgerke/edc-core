import type {
  CodeList,
  CodeListItem,
  ConditionDef,
  ItemDef,
  ItemGroupDef,
  ItemGroupRef,
  ItemRef,
  MetaDataVersion,
  MethodDef,
  OdmFile,
  StudyEventDef,
} from "./model.js";
import type { ValidationIssue } from "./validate.js";
import {
  asNode,
  attr,
  collectExtra,
  intAttr,
  OdmParseError,
  odmXmlParser,
  parseTranslatedTexts,
  requireAttr,
  type XNode,
} from "./xml.js";

/**
 * ODM 1.3.x import shim: upconverts a 1.3 metadata document to the v2.0
 * typed model, so legacy study definitions import through the same path
 * as native v2.0 files.
 *
 * Structural mapping (the v2.0 spec's own migration guidance):
 * - FormDef becomes ItemGroupDef Type="Form"; StudyEventDef FormRefs and
 *   FormDef ItemGroupRefs both become ItemGroupRefs
 * - GlobalVariables (StudyName/StudyDescription/ProtocolName) become Study
 *   attributes / Description
 * - MetaDataVersion's Description attribute becomes a Description element
 *
 * The conversion is lossy for constructs the v2 model doesn't carry
 * (BasicDefinitions, RangeChecks, ArchiveLayout, Protocol, embedded
 * ClinicalData/AdminData/ReferenceData); each drop is reported as a warning
 * rather than silently discarded.
 */

export interface Odm13ConversionResult {
  file: OdmFile;
  warnings: ValidationIssue[];
}

const ODM13_VERSION = /^1\.3(\.\d+)?$/;

/** Cheap detection on the root element, without a full parse. */
export function isOdm13Xml(content: string): boolean {
  const start = content.indexOf("<ODM");
  if (start === -1) return false;
  const end = content.indexOf(">", start);
  const rootTag = content.slice(start, end === -1 ? undefined : end);
  const version = /ODMVersion\s*=\s*"([^"]*)"/.exec(rootTag)?.[1];
  return version !== undefined && ODM13_VERSION.test(version);
}

function elementText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const node = asNode(value);
  return typeof node["#text"] === "string" ? node["#text"] : undefined;
}

function convertItemGroupRefs(node: XNode): ItemGroupRef[] {
  return ((node.ItemGroupRef as unknown[]) ?? []).map((raw) => {
    const n = asNode(raw);
    const mandatory = attr(n, "Mandatory");
    const orderNumber = intAttr(n, "OrderNumber");
    const cec = attr(n, "CollectionExceptionConditionOID");
    return {
      itemGroupOid: requireAttr(n, "ItemGroupOID", "ItemGroupRef"),
      ...(mandatory !== undefined ? { mandatory } : {}),
      ...(orderNumber !== undefined ? { orderNumber } : {}),
      ...(cec !== undefined ? { collectionExceptionConditionOid: cec } : {}),
    };
  });
}

function convertItemRefs(node: XNode): ItemRef[] {
  return ((node.ItemRef as unknown[]) ?? []).map((raw) => {
    const n = asNode(raw);
    const mandatory = attr(n, "Mandatory");
    const orderNumber = intAttr(n, "OrderNumber");
    const methodOid = attr(n, "MethodOID");
    const cec = attr(n, "CollectionExceptionConditionOID");
    return {
      itemOid: requireAttr(n, "ItemOID", "ItemRef"),
      ...(mandatory !== undefined ? { mandatory } : {}),
      ...(orderNumber !== undefined ? { orderNumber } : {}),
      ...(methodOid !== undefined ? { methodOid } : {}),
      ...(cec !== undefined ? { collectionExceptionConditionOid: cec } : {}),
    };
  });
}

function byOrderNumber<T extends { orderNumber?: number | undefined }>(refs: T[]): T[] {
  return [...refs].sort((a, b) => (a.orderNumber ?? 0) - (b.orderNumber ?? 0));
}

function convertConditionOrMethod(raw: unknown, context: string): ConditionDef & MethodDef {
  const n = asNode(raw);
  const type = attr(n, "Type");
  const description = parseTranslatedTexts(n.Description);
  return {
    oid: requireAttr(n, "OID", context),
    name: requireAttr(n, "Name", context),
    ...(type !== undefined ? { type } : {}),
    ...(description ? { description } : {}),
    formalExpressions: ((n.FormalExpression as unknown[]) ?? []).map((rawExpr) => {
      const e = asNode(rawExpr);
      const exprContext = attr(e, "Context");
      return {
        ...(exprContext !== undefined ? { context: exprContext } : {}),
        code: typeof e["#text"] === "string" ? e["#text"] : "",
      };
    }),
  };
}

function convertMetaDataVersion(raw: unknown, warnings: ValidationIssue[]): MetaDataVersion {
  const n = asNode(raw);
  const mdvOid = requireAttr(n, "OID", "MetaDataVersion");
  const name = attr(n, "Name");
  // In 1.3, MetaDataVersion Description is an attribute.
  const descriptionAttr = attr(n, "Description");
  const warn = (path: string, message: string) =>
    warnings.push({ severity: "warning", path, message });

  const itemGroupOids = new Set(
    ((n.ItemGroupDef as unknown[]) ?? []).map((g) => attr(asNode(g), "OID") ?? ""),
  );

  // FormDef and ItemGroupDef OIDs live in separate 1.3 namespaces but share
  // one in v2.0 — rename colliding forms and rewrite their FormRefs.
  const formOidMap = new Map<string, string>();
  const forms: ItemGroupDef[] = ((n.FormDef as unknown[]) ?? []).map((rawForm) => {
    const f = asNode(rawForm);
    const oid = requireAttr(f, "OID", "FormDef");
    let mapped = oid;
    if (itemGroupOids.has(oid)) {
      mapped = `FO.${oid}`;
      for (let i = 2; itemGroupOids.has(mapped); i++) mapped = `FO.${oid}_${i}`;
      warn(`FormDef[${oid}]`, `renamed to "${mapped}": OID collides with an ItemGroupDef`);
    }
    itemGroupOids.add(mapped);
    formOidMap.set(oid, mapped);
    if (f.ArchiveLayout) {
      warn(`FormDef[${oid}]`, "ArchiveLayout is not imported");
    }
    const repeating = attr(f, "Repeating");
    const description = parseTranslatedTexts(f.Description);
    return {
      oid: mapped,
      name: requireAttr(f, "Name", "FormDef"),
      type: "Form",
      ...(repeating !== undefined ? { repeating } : {}),
      ...(description ? { description } : {}),
      itemRefs: [],
      itemGroupRefs: byOrderNumber(convertItemGroupRefs(f)),
    };
  });

  const events: StudyEventDef[] = ((n.StudyEventDef as unknown[]) ?? []).map((rawEvent) => {
    const e = asNode(rawEvent);
    const eventOid = requireAttr(e, "OID", "StudyEventDef");
    const repeating = attr(e, "Repeating");
    const type = attr(e, "Type");
    const description = parseTranslatedTexts(e.Description);
    const formRefs = byOrderNumber(
      ((e.FormRef as unknown[]) ?? []).map((rawRef) => {
        const r = asNode(rawRef);
        const formOid = requireAttr(r, "FormOID", "FormRef");
        const mandatory = attr(r, "Mandatory");
        const orderNumber = intAttr(r, "OrderNumber");
        return {
          itemGroupOid: formOidMap.get(formOid) ?? formOid,
          ...(mandatory !== undefined ? { mandatory } : {}),
          ...(orderNumber !== undefined ? { orderNumber } : {}),
        };
      }),
    );
    return {
      oid: eventOid,
      name: requireAttr(e, "Name", "StudyEventDef"),
      ...(repeating !== undefined ? { repeating } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(description ? { description } : {}),
      itemGroupRefs: formRefs,
    };
  });

  // Preserve the protocol's event ordering; the v2 model has no Protocol node.
  const protocolOrder = new Map(
    ((asNode(n.Protocol).StudyEventRef as unknown[]) ?? []).map((rawRef, index) => {
      const r = asNode(rawRef);
      return [attr(r, "StudyEventOID") ?? "", intAttr(r, "OrderNumber") ?? index + 1];
    }),
  );
  if (protocolOrder.size > 0) {
    events.sort(
      (a, b) =>
        (protocolOrder.get(a.oid) ?? Number.MAX_SAFE_INTEGER) -
        (protocolOrder.get(b.oid) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  const sections: ItemGroupDef[] = ((n.ItemGroupDef as unknown[]) ?? []).map((rawGroup) => {
    const g = asNode(rawGroup);
    const repeating = attr(g, "Repeating");
    const description = parseTranslatedTexts(g.Description);
    return {
      oid: requireAttr(g, "OID", "ItemGroupDef"),
      name: requireAttr(g, "Name", "ItemGroupDef"),
      ...(repeating !== undefined ? { repeating } : {}),
      ...(description ? { description } : {}),
      itemRefs: byOrderNumber(convertItemRefs(g)),
      itemGroupRefs: [],
    };
  });

  const itemDefs: ItemDef[] = ((n.ItemDef as unknown[]) ?? []).map((rawItem) => {
    const i = asNode(rawItem);
    const oid = requireAttr(i, "OID", "ItemDef");
    if (i.RangeCheck) {
      warn(`ItemDef[${oid}]`, "RangeCheck is not imported (author a JSONata edit check instead)");
    }
    if (i.MeasurementUnitRef) {
      warn(`ItemDef[${oid}]`, "MeasurementUnitRef is not imported");
    }
    const length = intAttr(i, "Length");
    const significantDigits = intAttr(i, "SignificantDigits");
    const description = parseTranslatedTexts(i.Description);
    const question = parseTranslatedTexts(i.Question);
    const codeListRef = i.CodeListRef ? asNode(i.CodeListRef) : undefined;
    return {
      oid,
      name: requireAttr(i, "Name", "ItemDef"),
      dataType: requireAttr(i, "DataType", "ItemDef"),
      ...(length !== undefined ? { length } : {}),
      ...(significantDigits !== undefined ? { significantDigits } : {}),
      ...(description ? { description } : {}),
      ...(question ? { question } : {}),
      ...(codeListRef
        ? { codeListRef: { codeListOid: requireAttr(codeListRef, "CodeListOID", "CodeListRef") } }
        : {}),
    };
  });

  const codeLists: CodeList[] = ((n.CodeList as unknown[]) ?? []).map((rawList) => {
    const cl = asNode(rawList);
    const oid = requireAttr(cl, "OID", "CodeList");
    if (cl.ExternalCodeList) {
      warn(`CodeList[${oid}]`, "ExternalCodeList reference is not imported");
    }
    const items: CodeListItem[] = [
      ...((cl.CodeListItem as unknown[]) ?? []).map((rawItem) => {
        const item = asNode(rawItem);
        const decode = parseTranslatedTexts(item.Decode);
        return {
          codedValue: requireAttr(item, "CodedValue", "CodeListItem"),
          ...(decode ? { decode } : {}),
        };
      }),
      ...((cl.EnumeratedItem as unknown[]) ?? []).map((rawItem) => ({
        codedValue: requireAttr(asNode(rawItem), "CodedValue", "EnumeratedItem"),
      })),
    ];
    return {
      oid,
      name: requireAttr(cl, "Name", "CodeList"),
      dataType: requireAttr(cl, "DataType", "CodeList"),
      items,
    };
  });

  return {
    oid: mdvOid,
    ...(name !== undefined ? { name } : {}),
    ...(descriptionAttr !== undefined ? { description: [{ text: descriptionAttr }] } : {}),
    studyEventDefs: events,
    itemGroupDefs: [...forms, ...sections],
    itemDefs,
    codeLists,
    conditionDefs: ((n.ConditionDef as unknown[]) ?? []).map((c) =>
      convertConditionOrMethod(c, "ConditionDef"),
    ),
    methodDefs: ((n.MethodDef as unknown[]) ?? []).map((m) =>
      convertConditionOrMethod(m, "MethodDef"),
    ),
  };
}

export function upconvertOdm13Xml(content: string): Odm13ConversionResult {
  const doc = asNode(odmXmlParser.parse(content));
  const root = asNode(doc.ODM);
  if (Object.keys(root).length === 0) {
    throw new OdmParseError("document has no ODM root element");
  }
  const version = requireAttr(root, "ODMVersion", "ODM");
  if (!ODM13_VERSION.test(version)) {
    throw new OdmParseError(`not an ODM 1.3 document (ODMVersion "${version}")`);
  }

  const warnings: ValidationIssue[] = [];
  warnings.push({
    severity: "warning",
    path: "ODM",
    message: `converted from ODM ${version}; review the imported build before use`,
  });
  for (const dropped of ["ClinicalData", "ReferenceData", "AdminData"] as const) {
    if (root[dropped]) {
      warnings.push({
        severity: "warning",
        path: dropped,
        message: `${dropped} is not imported (study builds are metadata-only)`,
      });
    }
  }

  const studies = (root.Study as unknown[]) ?? [];
  const studyNode = asNode(studies[0]);
  let study: OdmFile["study"];
  if (studies.length > 0) {
    const globals = asNode(studyNode.GlobalVariables);
    if (studyNode.BasicDefinitions) {
      warnings.push({
        severity: "warning",
        path: "BasicDefinitions",
        message: "BasicDefinitions (measurement units) are not imported",
      });
    }
    const studyName = elementText(globals.StudyName);
    if (!studyName) throw new OdmParseError("GlobalVariables: missing StudyName");
    const protocolName = elementText(globals.ProtocolName);
    const studyDescription = elementText(globals.StudyDescription);
    study = {
      oid: requireAttr(studyNode, "OID", "Study"),
      studyName,
      ...(protocolName !== undefined ? { protocolName } : {}),
      ...(studyDescription ? { description: [{ text: studyDescription }] } : {}),
      metaDataVersions: ((studyNode.MetaDataVersion as unknown[]) ?? []).map((mdv) =>
        convertMetaDataVersion(mdv, warnings),
      ),
    };
  }

  const granularity = attr(root, "Granularity");
  const sourceSystem = attr(root, "SourceSystem");
  const sourceSystemVersion = attr(root, "SourceSystemVersion");
  const extra = collectExtra(
    root,
    [
      "FileOID",
      "FileType",
      "ODMVersion",
      "CreationDateTime",
      "Granularity",
      "SourceSystem",
      "SourceSystemVersion",
      "xmlns",
      "xmlns:xs",
      "xmlns:xlink",
      "xmlns:ds",
      "AsOfDateTime",
      "Archival",
      "PriorFileOID",
      "FileFormat",
    ],
    ["Study", "ClinicalData", "ReferenceData", "AdminData", "Association", "Signature"],
  );

  return {
    file: {
      fileOid: requireAttr(root, "FileOID", "ODM"),
      fileType: requireAttr(root, "FileType", "ODM"),
      odmVersion: "2.0",
      creationDateTime: requireAttr(root, "CreationDateTime", "ODM"),
      ...(granularity !== undefined ? { granularity } : {}),
      ...(sourceSystem !== undefined ? { sourceSystem } : {}),
      ...(sourceSystemVersion !== undefined ? { sourceSystemVersion } : {}),
      ...(study ? { study } : {}),
      ...(extra ? { extra } : {}),
    },
    warnings,
  };
}
