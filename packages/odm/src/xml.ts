import { XMLBuilder, XMLParser } from "fast-xml-parser";
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
  OdmStudy,
  StudyEventDef,
  TranslatedText,
} from "./model.js";

export const ODM_V2_NAMESPACE = "http://www.cdisc.org/ns/odm/v2.0";

// Elements that may occur more than once must always parse as arrays.
// Includes ODM 1.3-only elements so the same parser serves the 1.3 shim.
const ARRAY_ELEMENTS = new Set([
  "Study",
  "MetaDataVersion",
  "StudyEventDef",
  "ItemGroupDef",
  "ItemDef",
  "CodeList",
  "CodeListItem",
  "ItemGroupRef",
  "ItemRef",
  "TranslatedText",
  "ConditionDef",
  "MethodDef",
  "FormalExpression",
  "RangeCheck",
  "Alias",
  "FormDef",
  "FormRef",
  "StudyEventRef",
  "EnumeratedItem",
  "MeasurementUnit",
  "MeasurementUnitRef",
]);

export const odmXmlParser: XMLParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  isArray: (name) => ARRAY_ELEMENTS.has(name),
});

export type XNode = Record<string, unknown>;

export class OdmParseError extends Error {}

export function asNode(value: unknown): XNode {
  return typeof value === "object" && value !== null ? (value as XNode) : {};
}

export function attr(node: XNode, name: string): string | undefined {
  const value = node[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

export function requireAttr(node: XNode, name: string, context: string): string {
  const value = attr(node, name);
  if (!value) throw new OdmParseError(`${context}: missing required attribute ${name}`);
  return value;
}

export function intAttr(node: XNode, name: string): number | undefined {
  const raw = attr(node, name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** Everything not consumed by the typed mapping is preserved verbatim. */
export function collectExtra(
  node: XNode,
  knownAttrs: readonly string[],
  knownChildren: readonly string[],
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const isAttr = key.startsWith("@_");
    const name = isAttr ? key.slice(2) : key;
    if (key === "#text") continue;
    if (isAttr ? knownAttrs.includes(name) : knownChildren.includes(name)) continue;
    extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

export function parseTranslatedTexts(container: unknown): TranslatedText[] | undefined {
  const node = asNode(Array.isArray(container) ? container[0] : container);
  const list = node.TranslatedText;
  if (!list) return undefined;
  const texts = (Array.isArray(list) ? list : [list]).map((entry): TranslatedText => {
    if (typeof entry === "string") return { text: entry };
    const n = asNode(entry);
    const lang = attr(n, "xml:lang");
    const type = attr(n, "Type");
    return {
      ...(lang !== undefined ? { lang } : {}),
      ...(type !== undefined ? { type } : {}),
      text: typeof n["#text"] === "string" ? n["#text"] : "",
    };
  });
  return texts.length > 0 ? texts : undefined;
}

function parseItemGroupRefs(node: XNode): ItemGroupRef[] {
  return ((node.ItemGroupRef as unknown[]) ?? []).map((raw) => {
    const n = asNode(raw);
    const mandatory = attr(n, "Mandatory");
    const orderNumber = intAttr(n, "OrderNumber");
    const extra = collectExtra(n, ["ItemGroupOID", "Mandatory", "OrderNumber"], []);
    return {
      itemGroupOid: requireAttr(n, "ItemGroupOID", "ItemGroupRef"),
      ...(mandatory !== undefined ? { mandatory } : {}),
      ...(orderNumber !== undefined ? { orderNumber } : {}),
      ...(extra ? { extra } : {}),
    };
  });
}

function parseItemRefs(node: XNode): ItemRef[] {
  return ((node.ItemRef as unknown[]) ?? []).map((raw) => {
    const n = asNode(raw);
    const mandatory = attr(n, "Mandatory");
    const repeat = attr(n, "Repeat");
    const other = attr(n, "Other");
    const orderNumber = intAttr(n, "OrderNumber");
    const methodOid = attr(n, "MethodOID");
    const cec = attr(n, "CollectionExceptionConditionOID");
    const extra = collectExtra(
      n,
      [
        "ItemOID",
        "Mandatory",
        "Repeat",
        "Other",
        "OrderNumber",
        "MethodOID",
        "CollectionExceptionConditionOID",
      ],
      [],
    );
    return {
      itemOid: requireAttr(n, "ItemOID", "ItemRef"),
      ...(mandatory !== undefined ? { mandatory } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
      ...(other !== undefined ? { other } : {}),
      ...(orderNumber !== undefined ? { orderNumber } : {}),
      ...(methodOid !== undefined ? { methodOid } : {}),
      ...(cec !== undefined ? { collectionExceptionConditionOid: cec } : {}),
      ...(extra ? { extra } : {}),
    };
  });
}

function parseStudyEventDef(raw: unknown): StudyEventDef {
  const n = asNode(raw);
  const repeating = attr(n, "Repeating");
  const type = attr(n, "Type");
  const description = parseTranslatedTexts(n.Description);
  const extra = collectExtra(
    n,
    ["OID", "Name", "Repeating", "Type"],
    ["Description", "ItemGroupRef"],
  );
  return {
    oid: requireAttr(n, "OID", "StudyEventDef"),
    name: requireAttr(n, "Name", "StudyEventDef"),
    ...(repeating !== undefined ? { repeating } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(description ? { description } : {}),
    itemGroupRefs: parseItemGroupRefs(n),
    ...(extra ? { extra } : {}),
  };
}

function parseItemGroupDef(raw: unknown): ItemGroupDef {
  const n = asNode(raw);
  const type = attr(n, "Type");
  const repeating = attr(n, "Repeating");
  const description = parseTranslatedTexts(n.Description);
  const extra = collectExtra(
    n,
    ["OID", "Name", "Type", "Repeating"],
    ["Description", "ItemRef", "ItemGroupRef"],
  );
  return {
    oid: requireAttr(n, "OID", "ItemGroupDef"),
    name: requireAttr(n, "Name", "ItemGroupDef"),
    ...(type !== undefined ? { type } : {}),
    ...(repeating !== undefined ? { repeating } : {}),
    ...(description ? { description } : {}),
    itemRefs: parseItemRefs(n),
    itemGroupRefs: parseItemGroupRefs(n),
    ...(extra ? { extra } : {}),
  };
}

function parseItemDef(raw: unknown): ItemDef {
  const n = asNode(raw);
  const length = intAttr(n, "Length");
  const significantDigits = intAttr(n, "SignificantDigits");
  const description = parseTranslatedTexts(n.Description);
  const question = parseTranslatedTexts(n.Question);
  const codeListRefNode = n.CodeListRef ? asNode(n.CodeListRef) : undefined;
  const extra = collectExtra(
    n,
    ["OID", "Name", "DataType", "Length", "SignificantDigits"],
    ["Description", "Question", "CodeListRef"],
  );
  return {
    oid: requireAttr(n, "OID", "ItemDef"),
    name: requireAttr(n, "Name", "ItemDef"),
    dataType: requireAttr(n, "DataType", "ItemDef"),
    ...(length !== undefined ? { length } : {}),
    ...(significantDigits !== undefined ? { significantDigits } : {}),
    ...(description ? { description } : {}),
    ...(question ? { question } : {}),
    ...(codeListRefNode
      ? { codeListRef: { codeListOid: requireAttr(codeListRefNode, "CodeListOID", "CodeListRef") } }
      : {}),
    ...(extra ? { extra } : {}),
  };
}

function parseCodeList(raw: unknown): CodeList {
  const n = asNode(raw);
  const items = ((n.CodeListItem as unknown[]) ?? []).map((rawItem): CodeListItem => {
    const item = asNode(rawItem);
    const decode = parseTranslatedTexts(item.Decode);
    const extra = collectExtra(item, ["CodedValue"], ["Decode"]);
    return {
      codedValue: requireAttr(item, "CodedValue", "CodeListItem"),
      ...(decode ? { decode } : {}),
      ...(extra ? { extra } : {}),
    };
  });
  const extra = collectExtra(n, ["OID", "Name", "DataType"], ["CodeListItem"]);
  return {
    oid: requireAttr(n, "OID", "CodeList"),
    name: requireAttr(n, "Name", "CodeList"),
    dataType: requireAttr(n, "DataType", "CodeList"),
    items,
    ...(extra ? { extra } : {}),
  };
}

function parseFormalExpressions(node: XNode) {
  return ((node.FormalExpression as unknown[]) ?? []).map((raw) => {
    const n = asNode(raw);
    const context = attr(n, "Context");
    return {
      ...(context !== undefined ? { context } : {}),
      code: typeof n["#text"] === "string" ? n["#text"] : "",
    };
  });
}

function parseConditionOrMethod(raw: unknown, context: string): ConditionDef & MethodDef {
  const n = asNode(raw);
  const type = attr(n, "Type");
  const description = parseTranslatedTexts(n.Description);
  const extra = collectExtra(n, ["OID", "Name", "Type"], ["Description", "FormalExpression"]);
  return {
    oid: requireAttr(n, "OID", context),
    name: requireAttr(n, "Name", context),
    ...(type !== undefined ? { type } : {}),
    ...(description ? { description } : {}),
    formalExpressions: parseFormalExpressions(n),
    ...(extra ? { extra } : {}),
  };
}

function parseMetaDataVersion(raw: unknown): MetaDataVersion {
  const n = asNode(raw);
  const name = attr(n, "Name");
  const description = parseTranslatedTexts(n.Description);
  const extra = collectExtra(
    n,
    ["OID", "Name"],
    [
      "Description",
      "StudyEventDef",
      "ItemGroupDef",
      "ItemDef",
      "CodeList",
      "ConditionDef",
      "MethodDef",
    ],
  );
  return {
    oid: requireAttr(n, "OID", "MetaDataVersion"),
    ...(name !== undefined ? { name } : {}),
    ...(description ? { description } : {}),
    studyEventDefs: ((n.StudyEventDef as unknown[]) ?? []).map(parseStudyEventDef),
    itemGroupDefs: ((n.ItemGroupDef as unknown[]) ?? []).map(parseItemGroupDef),
    itemDefs: ((n.ItemDef as unknown[]) ?? []).map(parseItemDef),
    codeLists: ((n.CodeList as unknown[]) ?? []).map(parseCodeList),
    conditionDefs: ((n.ConditionDef as unknown[]) ?? []).map((c) =>
      parseConditionOrMethod(c, "ConditionDef"),
    ),
    methodDefs: ((n.MethodDef as unknown[]) ?? []).map((m) =>
      parseConditionOrMethod(m, "MethodDef"),
    ),
    ...(extra ? { extra } : {}),
  };
}

function parseStudy(raw: unknown): OdmStudy {
  const n = asNode(raw);
  const protocolName = attr(n, "ProtocolName");
  const description = parseTranslatedTexts(n.Description);
  const extra = collectExtra(
    n,
    ["OID", "StudyName", "ProtocolName"],
    ["Description", "MetaDataVersion"],
  );
  return {
    oid: requireAttr(n, "OID", "Study"),
    studyName: requireAttr(n, "StudyName", "Study"),
    ...(protocolName !== undefined ? { protocolName } : {}),
    ...(description ? { description } : {}),
    metaDataVersions: ((n.MetaDataVersion as unknown[]) ?? []).map(parseMetaDataVersion),
    ...(extra ? { extra } : {}),
  };
}

export function parseOdmXml(content: string): OdmFile {
  const doc = asNode(odmXmlParser.parse(content));
  const root = asNode(doc.ODM);
  if (Object.keys(root).length === 0) {
    throw new OdmParseError("document has no ODM root element");
  }
  const odmVersion = requireAttr(root, "ODMVersion", "ODM");
  if (odmVersion !== "2.0") {
    throw new OdmParseError(`unsupported ODMVersion "${odmVersion}" (expected 2.0)`);
  }
  const studies = (root.Study as unknown[]) ?? [];
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
    ],
    ["Study"],
  );
  return {
    fileOid: requireAttr(root, "FileOID", "ODM"),
    fileType: requireAttr(root, "FileType", "ODM"),
    odmVersion: "2.0",
    creationDateTime: requireAttr(root, "CreationDateTime", "ODM"),
    ...(granularity !== undefined ? { granularity } : {}),
    ...(sourceSystem !== undefined ? { sourceSystem } : {}),
    ...(sourceSystemVersion !== undefined ? { sourceSystemVersion } : {}),
    ...(studies.length > 0 ? { study: parseStudy(studies[0]) } : {}),
    ...(extra ? { extra } : {}),
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  format: true,
  suppressEmptyNode: true,
});

function withExtra(node: XNode, extra: Record<string, unknown> | undefined): XNode {
  return extra ? { ...node, ...extra } : node;
}

function buildTranslatedTexts(texts: TranslatedText[] | undefined) {
  if (!texts) return undefined;
  return {
    TranslatedText: texts.map((t) => ({
      ...(t.lang !== undefined ? { "@_xml:lang": t.lang } : {}),
      ...(t.type !== undefined ? { "@_Type": t.type } : {}),
      "#text": t.text,
    })),
  };
}

function buildItemGroupRefs(refs: ItemGroupRef[]) {
  return refs.map((ref) =>
    withExtra(
      {
        "@_ItemGroupOID": ref.itemGroupOid,
        ...(ref.mandatory !== undefined ? { "@_Mandatory": ref.mandatory } : {}),
        ...(ref.orderNumber !== undefined ? { "@_OrderNumber": String(ref.orderNumber) } : {}),
      },
      ref.extra,
    ),
  );
}

function buildItemRefs(refs: ItemRef[]) {
  return refs.map((ref) =>
    withExtra(
      {
        "@_ItemOID": ref.itemOid,
        ...(ref.mandatory !== undefined ? { "@_Mandatory": ref.mandatory } : {}),
        ...(ref.repeat !== undefined ? { "@_Repeat": ref.repeat } : {}),
        ...(ref.other !== undefined ? { "@_Other": ref.other } : {}),
        ...(ref.orderNumber !== undefined ? { "@_OrderNumber": String(ref.orderNumber) } : {}),
        ...(ref.methodOid !== undefined ? { "@_MethodOID": ref.methodOid } : {}),
        ...(ref.collectionExceptionConditionOid !== undefined
          ? { "@_CollectionExceptionConditionOID": ref.collectionExceptionConditionOid }
          : {}),
      },
      ref.extra,
    ),
  );
}

function buildFormalExpressions(expressions: ConditionDef["formalExpressions"]) {
  return expressions.map((e) => ({
    ...(e.context !== undefined ? { "@_Context": e.context } : {}),
    "#text": e.code,
  }));
}

export function serializeOdmXml(file: OdmFile): string {
  const study = file.study;
  const doc = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    ODM: withExtra(
      {
        "@_xmlns": ODM_V2_NAMESPACE,
        "@_FileOID": file.fileOid,
        "@_FileType": file.fileType,
        "@_ODMVersion": file.odmVersion,
        "@_CreationDateTime": file.creationDateTime,
        ...(file.granularity !== undefined ? { "@_Granularity": file.granularity } : {}),
        ...(file.sourceSystem !== undefined ? { "@_SourceSystem": file.sourceSystem } : {}),
        ...(file.sourceSystemVersion !== undefined
          ? { "@_SourceSystemVersion": file.sourceSystemVersion }
          : {}),
        ...(study
          ? {
              Study: withExtra(
                {
                  "@_OID": study.oid,
                  "@_StudyName": study.studyName,
                  ...(study.protocolName !== undefined
                    ? { "@_ProtocolName": study.protocolName }
                    : {}),
                  ...(study.description
                    ? { Description: buildTranslatedTexts(study.description) }
                    : {}),
                  MetaDataVersion: study.metaDataVersions.map((mdv) =>
                    withExtra(
                      {
                        "@_OID": mdv.oid,
                        ...(mdv.name !== undefined ? { "@_Name": mdv.name } : {}),
                        ...(mdv.description
                          ? { Description: buildTranslatedTexts(mdv.description) }
                          : {}),
                        StudyEventDef: mdv.studyEventDefs.map((se) =>
                          withExtra(
                            {
                              "@_OID": se.oid,
                              "@_Name": se.name,
                              ...(se.repeating !== undefined
                                ? { "@_Repeating": se.repeating }
                                : {}),
                              ...(se.type !== undefined ? { "@_Type": se.type } : {}),
                              ...(se.description
                                ? { Description: buildTranslatedTexts(se.description) }
                                : {}),
                              ItemGroupRef: buildItemGroupRefs(se.itemGroupRefs),
                            },
                            se.extra,
                          ),
                        ),
                        ItemGroupDef: mdv.itemGroupDefs.map((ig) =>
                          withExtra(
                            {
                              "@_OID": ig.oid,
                              "@_Name": ig.name,
                              ...(ig.type !== undefined ? { "@_Type": ig.type } : {}),
                              ...(ig.repeating !== undefined
                                ? { "@_Repeating": ig.repeating }
                                : {}),
                              ...(ig.description
                                ? { Description: buildTranslatedTexts(ig.description) }
                                : {}),
                              ItemRef: buildItemRefs(ig.itemRefs),
                              ItemGroupRef: buildItemGroupRefs(ig.itemGroupRefs),
                            },
                            ig.extra,
                          ),
                        ),
                        ItemDef: mdv.itemDefs.map((item) =>
                          withExtra(
                            {
                              "@_OID": item.oid,
                              "@_Name": item.name,
                              "@_DataType": item.dataType,
                              ...(item.length !== undefined
                                ? { "@_Length": String(item.length) }
                                : {}),
                              ...(item.significantDigits !== undefined
                                ? { "@_SignificantDigits": String(item.significantDigits) }
                                : {}),
                              ...(item.description
                                ? { Description: buildTranslatedTexts(item.description) }
                                : {}),
                              ...(item.question
                                ? { Question: buildTranslatedTexts(item.question) }
                                : {}),
                              ...(item.codeListRef
                                ? { CodeListRef: { "@_CodeListOID": item.codeListRef.codeListOid } }
                                : {}),
                            },
                            item.extra,
                          ),
                        ),
                        CodeList: mdv.codeLists.map((cl) =>
                          withExtra(
                            {
                              "@_OID": cl.oid,
                              "@_Name": cl.name,
                              "@_DataType": cl.dataType,
                              CodeListItem: cl.items.map((item) =>
                                withExtra(
                                  {
                                    "@_CodedValue": item.codedValue,
                                    ...(item.decode
                                      ? { Decode: buildTranslatedTexts(item.decode) }
                                      : {}),
                                  },
                                  item.extra,
                                ),
                              ),
                            },
                            cl.extra,
                          ),
                        ),
                        ConditionDef: mdv.conditionDefs.map((cond) =>
                          withExtra(
                            {
                              "@_OID": cond.oid,
                              "@_Name": cond.name,
                              ...(cond.description
                                ? { Description: buildTranslatedTexts(cond.description) }
                                : {}),
                              FormalExpression: buildFormalExpressions(cond.formalExpressions),
                            },
                            cond.extra,
                          ),
                        ),
                        MethodDef: mdv.methodDefs.map((method) =>
                          withExtra(
                            {
                              "@_OID": method.oid,
                              "@_Name": method.name,
                              ...(method.type !== undefined ? { "@_Type": method.type } : {}),
                              ...(method.description
                                ? { Description: buildTranslatedTexts(method.description) }
                                : {}),
                              FormalExpression: buildFormalExpressions(method.formalExpressions),
                            },
                            method.extra,
                          ),
                        ),
                      },
                      mdv.extra,
                    ),
                  ),
                },
                study.extra,
              ),
            }
          : {}),
      },
      file.extra,
    ),
  };
  return builder.build(doc) as string;
}
