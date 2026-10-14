import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ByokCipherError,
  LOCAL_SECRET_FILE_ENV,
  decryptByokSecret,
  encryptByokSecret,
  localByokSecretPath,
  resolveByokEncryptionSecret,
} from "./crypto.js";
import { LOCAL_MODE_ENV } from "./local-mode.js";

const TEST_KEY = Buffer.alloc(32, 42).toString("base64url");

beforeEach(() => {
  process.env.BYOK_ENCRYPTION_KEY = TEST_KEY;
});

describe("byok cipher", () => {
  it("round-trips a secret", () => {
    const secret = "sk-test-abc123中文";
    const payload = encryptByokSecret(secret);
    expect(payload.startsWith("v1:")).toBe(true);
    expect(payload).not.toContain("sk-test");
    expect(decryptByokSecret(payload)).toBe(secret);
  });

  it("produces fresh ivs per call", () => {
    expect(encryptByokSecret("a")).not.toBe(encryptByokSecret("a"));
  });

  it("rejects tampered ciphertext", () => {
    const payload = encryptByokSecret("secret");
    const parts = payload.split(":");
    parts[2] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptByokSecret(parts.join(":"))).toThrow(ByokCipherError);
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptByokSecret("v1:not-enough")).toThrow(ByokCipherError);
    expect(() => decryptByokSecret("v9:a:b:c")).toThrow(ByokCipherError);
  });

  it("accepts any non-empty passphrase by deriving the key", () => {
    process.env.BYOK_ENCRYPTION_KEY = "LINGQI_BRING_YOUR_OWN_KEY";
    const payload = encryptByokSecret("secret");
    expect(decryptByokSecret(payload)).toBe("secret");
  });

  it("refuses to run without the env var in hosted mode", () => {
    delete process.env.BYOK_ENCRYPTION_KEY;
    const previousLocalMode = process.env[LOCAL_MODE_ENV];
    delete process.env[LOCAL_MODE_ENV];
    try {
      expect(() => encryptByokSecret("x")).toThrow(/BYOK_ENCRYPTION_KEY/);
    } finally {
      if (previousLocalMode !== undefined) process.env[LOCAL_MODE_ENV] = previousLocalMode;
    }
  });
});

describe("local-mode BYOK secret", () => {
  let dir: string;
  let secretPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "novel-vibe-byok-"));
    secretPath = join(dir, "byok-encryption-key");
    delete process.env.BYOK_ENCRYPTION_KEY;
    process.env[LOCAL_MODE_ENV] = "1";
    process.env[LOCAL_SECRET_FILE_ENV] = secretPath;
  });

  afterEach(() => {
    delete process.env[LOCAL_MODE_ENV];
    delete process.env[LOCAL_SECRET_FILE_ENV];
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the configured secret path", () => {
    expect(localByokSecretPath()).toBe(secretPath);
  });

  it("generates a 0600 secret file on first use and round-trips with it", () => {
    // Configuration alone must not touch the filesystem.
    expect(() => statSync(secretPath)).toThrow();

    const payload = encryptByokSecret("sk-local-secret");

    expect(decryptByokSecret(payload)).toBe("sk-local-secret");
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(secretPath, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("keeps one stable secret across calls, instances and restarts", () => {
    const first = resolveByokEncryptionSecret();
    expect(first).toBeTruthy();

    // Same process, later call.
    expect(resolveByokEncryptionSecret()).toBe(first);
    // Fresh env snapshot, as if the server had restarted.
    expect(resolveByokEncryptionSecret({ ...process.env })).toBe(first);
    // The ciphertext written under one resolution stays readable under the next.
    expect(decryptByokSecret(encryptByokSecret("stable"))).toBe("stable");
  });

  it("does not pick up or create a local file outside local mode", () => {
    delete process.env[LOCAL_MODE_ENV];

    expect(resolveByokEncryptionSecret()).toBeNull();
    expect(() => encryptByokSecret("x")).toThrow(/BYOK_ENCRYPTION_KEY/);
    expect(() => statSync(secretPath)).toThrow();
  });

  it("lets an explicit BYOK_ENCRYPTION_KEY win over the local file", () => {
    process.env.BYOK_ENCRYPTION_KEY = TEST_KEY;

    expect(resolveByokEncryptionSecret()).toBe(TEST_KEY);
    expect(encryptByokSecret("env-wins")).toBeTruthy();
    expect(() => statSync(secretPath)).toThrow();
  });
});
