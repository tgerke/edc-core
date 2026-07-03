import { describe, expect, it } from "vitest";
import { detectOdmSerialization, SUPPORTED_ODM_VERSION } from "./index.js";

describe("detectOdmSerialization", () => {
  it("detects XML", () => {
    expect(detectOdmSerialization('<?xml version="1.0"?><ODM/>')).toBe("xml");
    expect(detectOdmSerialization("  <ODM/>")).toBe("xml");
  });

  it("detects JSON", () => {
    expect(detectOdmSerialization('{"odmVersion":"2.0"}')).toBe("json");
  });

  it("throws on unrecognized content", () => {
    expect(() => detectOdmSerialization("subject,visit,value")).toThrow();
  });
});

it("targets ODM v2.0", () => {
  expect(SUPPORTED_ODM_VERSION).toBe("2.0");
});
