/**
 * CDISC ODM v2.0 parse / validate / serialize.
 *
 * XML follows the official ODM v2.0 schema (metadata subset; unmodeled
 * constructs are preserved verbatim in `extra` bags and round-trip).
 * The JSON serialization is the canonical JSON form of the typed model.
 */
import { type OdmFile, odmFileSchema } from "./model.js";
import { isOdm13Xml, upconvertOdm13Xml } from "./odm13.js";
import { parseOdmXml, serializeOdmXml } from "./xml.js";

export * from "./diff.js";
export * from "./model.js";
export { isOdm13Xml, type Odm13ConversionResult, upconvertOdm13Xml } from "./odm13.js";
export * from "./validate.js";
export { ODM_V2_NAMESPACE, parseOdmXml, serializeOdmXml } from "./xml.js";

export const SUPPORTED_ODM_VERSION = "2.0";

export type OdmSerialization = "xml" | "json";

/** Detect whether raw ODM content is the XML or JSON serialization. */
export function detectOdmSerialization(content: string): OdmSerialization {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{")) return "json";
  if (trimmed.startsWith("<")) return "xml";
  throw new Error("Content is neither ODM XML nor ODM JSON");
}

/**
 * Parse ODM content in either serialization into the typed model.
 * ODM 1.3.x XML is upconverted transparently; use `upconvertOdm13Xml`
 * directly when the conversion warnings are needed.
 */
export function parseOdm(content: string): OdmFile {
  if (detectOdmSerialization(content) === "xml") {
    if (isOdm13Xml(content)) {
      return odmFileSchema.parse(upconvertOdm13Xml(content).file);
    }
    return odmFileSchema.parse(parseOdmXml(content));
  }
  return odmFileSchema.parse(JSON.parse(content));
}

export function serializeOdm(file: OdmFile, serialization: OdmSerialization): string {
  if (serialization === "xml") return serializeOdmXml(file);
  return JSON.stringify(file, null, 2);
}
export * from "./edit.js";
export * from "./resolve.js";
