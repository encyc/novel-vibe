import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LOCAL_MODE_ENV,
  LOCAL_USER_EMAIL,
  LOCAL_USER_ID,
  isLocalModeEnabled,
  loadConfig,
} from "./config.js";

describe("loadConfig", () => {
  it("allows the local Vite origins by default outside production", () => {
    const config = loadConfig({
      JWT_SECRET: "test-secret",
      NODE_ENV: "development",
    });

    expect(config.allowedOrigins).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  });

  it("defaults to hosted mode and still requires JWT_SECRET", () => {
    expect(isLocalModeEnabled({})).toBe(false);
    expect(() => loadConfig({ NODE_ENV: "development" })).toThrow("JWT_SECRET env var is required");
  });

  it("keeps requiring JWT_SECRET for non-local truthy-looking flag values", () => {
    for (const value of ["0", "false", "off", "no", "maybe", ""]) {
      expect(isLocalModeEnabled({ [LOCAL_MODE_ENV]: value })).toBe(false);
      expect(() => loadConfig({ NODE_ENV: "development", [LOCAL_MODE_ENV]: value }))
        .toThrow("JWT_SECRET env var is required");
    }
  });

  it("starts local mode without JWT_SECRET", () => {
    const config = loadConfig({ NODE_ENV: "development", [LOCAL_MODE_ENV]: "1" });

    expect(config.localMode).toBe(true);
    expect(config.jwtSecret).toBe("");
  });

  it("keeps a configured JWT_SECRET in local mode", () => {
    const config = loadConfig({ NODE_ENV: "development", JWT_SECRET: "test-secret", [LOCAL_MODE_ENV]: "on" });

    expect(config.localMode).toBe(true);
    expect(config.jwtSecret).toBe("test-secret");
  });
});

describe("isLocalModeEnabled", () => {
  it("accepts 1/true/yes/on case-insensitively and trims whitespace", () => {
    for (const value of ["1", "true", "TRUE", "yes", "YES", "on", "On", "  true  "]) {
      expect(isLocalModeEnabled({ [LOCAL_MODE_ENV]: value })).toBe(true);
    }
  });

  it("treats an unset flag as hosted mode", () => {
    expect(isLocalModeEnabled({})).toBe(false);
  });
});

describe("the local identity has one value across packages", () => {
  // `novel-web` may not import `novel-agents` — that would cross the boundary the
  // architecture check enforces — so the fixed local identity is written out again in
  // config.ts and, as a display fallback, in the WebUI. A silent divergence would leave
  // the BFF and the UI naming a different user than the one that owns the local data,
  // which is exactly the kind of drift nobody notices until it matters. Pin all three.
  const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

  const literal = (text: string, name: string): string => {
    const match = text.match(new RegExp(`${name}\\s*[:=]\\s*"([^"]+)"`));
    if (!match?.[1]) throw new Error(`no ${name} literal found`);
    return match[1];
  };

  it("matches the agent server's source of truth and the WebUI fallback", () => {
    const agents = source("../../novel-agents/lib/local-mode.ts");
    expect(literal(agents, "LOCAL_USER_ID")).toBe(LOCAL_USER_ID);
    expect(literal(agents, "LOCAL_USER_EMAIL")).toBe(LOCAL_USER_EMAIL);

    const webui = source("../../novel-webui/src/local-mode.tsx");
    const fallback = webui.slice(webui.indexOf("LOCAL_IDENTITY_FALLBACK"));
    expect(fallback).not.toBe("");
    expect(literal(fallback, "id")).toBe(LOCAL_USER_ID);
    expect(literal(fallback, "email")).toBe(LOCAL_USER_EMAIL);
  });
});
