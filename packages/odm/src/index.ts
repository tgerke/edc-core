/**
 * CDISC ODM v2.0 parse / validate / serialize.
 *
 * ODM v2.0 defines both XML and JSON serializations of the same model
 * (https://www.cdisc.org/standards/data-exchange/odm-xml/odm-v2-0).
 * Phase 2 implements the full parser; this module currently establishes
 * the package boundary and serialization detection.
 */

export const SUPPORTED_ODM_VERSION = "2.0";

export type OdmSerialization = "xml" | "json";

/** Detect whether raw ODM content is the XML or JSON serialization. */
export function detectOdmSerialization(content: string): OdmSerialization {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{")) return "json";
  if (trimmed.startsWith("<")) return "xml";
  throw new Error("Content is neither ODM XML nor ODM JSON");
}
