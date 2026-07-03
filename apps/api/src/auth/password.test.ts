import { describe, expect, it } from "vitest";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "./password.js";

describe("validatePasswordPolicy", () => {
  it("rejects short passwords", () => {
    expect(validatePasswordPolicy("Ab1!", 12)).toMatch(/at least 12/);
  });

  it("rejects passwords with fewer than three character classes", () => {
    expect(validatePasswordPolicy("alllowercaseletters", 12)).toMatch(/three of/);
    expect(validatePasswordPolicy("lowerUPPERonly!!", 12)).toBeNull();
  });

  it("accepts compliant passwords", () => {
    expect(validatePasswordPolicy("correct-Horse-battery-7", 12)).toBeNull();
  });
});

describe("argon2 hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct-Horse-battery-7");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "correct-Horse-battery-7")).toBe(true);
    expect(await verifyPassword(hash, "wrong-password-123!")).toBe(false);
  });

  it("returns false on malformed hashes instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});
