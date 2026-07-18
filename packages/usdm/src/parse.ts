import { type UsdmWrapper, usdmWrapperSchema } from "./model.js";

export const SUPPORTED_USDM_VERSION_MAJOR = "4";

/**
 * Parse USDM API wrapper JSON into the typed model. Unknown keys are ignored
 * (the raw JSON is what gets stored); shape violations in consumed fields
 * throw. Semantic problems (dangling references, missing timelines) are the
 * domain of validateUsdmPackage.
 */
export function parseUsdm(content: string | unknown): UsdmWrapper {
  const raw = typeof content === "string" ? JSON.parse(content) : content;
  return usdmWrapperSchema.parse(raw);
}
