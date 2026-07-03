import { describe, expect, it } from "vitest";
import { healthResponseSchema, oidSchema } from "./index.js";

describe("healthResponseSchema", () => {
  it("accepts a valid health payload", () => {
    const result = healthResponseSchema.safeParse({
      status: "ok",
      service: "edc-core-api",
      version: "0.0.1",
      time: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-ok status", () => {
    const result = healthResponseSchema.safeParse({
      status: "degraded",
      service: "edc-core-api",
      version: "0.0.1",
      time: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe("oidSchema", () => {
  it("accepts typical ODM OIDs", () => {
    for (const oid of ["ST.001", "IT.VS.SYSBP", "MDV.1"]) {
      expect(oidSchema.safeParse(oid).success).toBe(true);
    }
  });

  it("rejects empty and whitespace-padded OIDs", () => {
    for (const oid of ["", " ST.001", "ST.001 "]) {
      expect(oidSchema.safeParse(oid).success).toBe(false);
    }
  });
});
