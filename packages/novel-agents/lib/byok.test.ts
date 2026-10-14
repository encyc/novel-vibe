import { describe, expect, it } from "vitest";
import {
  BYOK_ALLOWED_PROVIDERS,
  BYOK_PROVIDER_PREFIX,
  byokEncryptionConfigured,
  isByokProvider,
  splitByokProvider,
} from "./byok.js";
import { LOCAL_MODE_ENV } from "./local-mode.js";

describe("splitByokProvider", () => {
  it("splits an allowed byok provider", () => {
    expect(splitByokProvider("byok-deepseek")).toBe("deepseek");
    expect(splitByokProvider("byok-zai-coding-cn")).toBe("zai-coding-cn");
  });

  it("returns null for platform providers", () => {
    expect(splitByokProvider("deepseek")).toBeNull();
    expect(splitByokProvider("opencode")).toBeNull();
  });

  it("returns null for unknown byok bases", () => {
    expect(splitByokProvider("byok-not-a-provider")).toBeNull();
  });

  it("keeps the allowlist and prefix coherent", () => {
    for (const base of BYOK_ALLOWED_PROVIDERS) {
      expect(splitByokProvider(`${BYOK_PROVIDER_PREFIX}${base}`)).toBe(base);
      expect(isByokProvider(`${BYOK_PROVIDER_PREFIX}${base}`)).toBe(true);
    }
    expect(isByokProvider("byok-not-a-provider")).toBe(true);
    expect(isByokProvider("deepseek")).toBe(false);
  });
});

describe("byokEncryptionConfigured", () => {
  it("reflects BYOK_ENCRYPTION_KEY presence", () => {
    const previous = process.env.BYOK_ENCRYPTION_KEY;
    const previousLocalMode = process.env[LOCAL_MODE_ENV];
    try {
      delete process.env.BYOK_ENCRYPTION_KEY;
      delete process.env[LOCAL_MODE_ENV];
      expect(byokEncryptionConfigured()).toBe(false);
      process.env.BYOK_ENCRYPTION_KEY =
        Buffer.alloc(32, 7).toString("base64url");
      expect(byokEncryptionConfigured()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
      else process.env.BYOK_ENCRYPTION_KEY = previous;
      if (previousLocalMode === undefined) delete process.env[LOCAL_MODE_ENV];
      else process.env[LOCAL_MODE_ENV] = previousLocalMode;
    }
  });

  it("stays fail-closed in hosted mode and resolves the local secret in local mode", () => {
    const previous = process.env.BYOK_ENCRYPTION_KEY;
    const previousLocalMode = process.env[LOCAL_MODE_ENV];
    try {
      delete process.env.BYOK_ENCRYPTION_KEY;

      // Hosted: a missing key means BYOK is disabled, never a local fallback.
      delete process.env[LOCAL_MODE_ENV];
      expect(byokEncryptionConfigured()).toBe(false);

      // Local: the file-backed per-install secret is available.
      process.env[LOCAL_MODE_ENV] = "1";
      expect(byokEncryptionConfigured()).toBe(true);

      // Only the recognised truthy spellings count as local mode.
      process.env[LOCAL_MODE_ENV] = "false";
      expect(byokEncryptionConfigured()).toBe(false);

      // An explicit key is authoritative in every mode.
      process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");
      expect(byokEncryptionConfigured()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BYOK_ENCRYPTION_KEY;
      else process.env.BYOK_ENCRYPTION_KEY = previous;
      if (previousLocalMode === undefined) delete process.env[LOCAL_MODE_ENV];
      else process.env[LOCAL_MODE_ENV] = previousLocalMode;
    }
  });
});
