import { describe, expect, it } from "vitest";
import {
  generateEmailCode, generateOpaqueToken, isRegistrationEmail,
  normalizeRegistrationEmail, registrationSecret, secretHash,
} from "./crypto.js";

describe("registration crypto", () => {
  it("normalizes and validates email without provider alias rewriting", () => {
    expect(normalizeRegistrationEmail(" User+draft@Example.com ")).toBe("user+draft@example.com");
    expect(isRegistrationEmail("user+draft@example.com")).toBe(true);
    expect(isRegistrationEmail("bad address")).toBe(false);
  });

  it("creates six digit codes and 32-byte opaque tokens", () => {
    expect(generateEmailCode()).toMatch(/^\d{6}$/);
    expect(Buffer.from(generateOpaqueToken(), "base64url")).toHaveLength(32);
  });

  it("hashes secrets by purpose and never returns the raw value", () => {
    expect(secretHash("secret", "code", "123456")).not.toContain("123456");
    expect(secretHash("secret", "code", "123456")).not.toBe(secretHash("secret", "ticket", "123456"));
  });

  it("requires a dedicated production secret", () => {
    expect(() => registrationSecret({ NODE_ENV: "production", JWT_SECRET: "fallback" })).toThrow("REGISTRATION_TOKEN_SECRET");
    expect(registrationSecret({ NODE_ENV: "test", JWT_SECRET: "fallback" })).toBe("fallback");
  });
});
