import { describe, expect, it } from "vitest";
import { API_SCOPES, expandScopePresets, hasScopes } from "./scopes.js";

describe("API scopes", () => {
  it("does not allow token management to be delegated", () => {
    expect(API_SCOPES["tokens:manage"].delegable).toBe(false);
  });

  it("expands read, write, and agent presets to their explicit scopes", () => {
    const scopes = expandScopePresets(["read", "write", "agent:run"]);

    expect(scopes).toEqual(expect.arrayContaining([
      "projects:read",
      "documents:read",
      "sessions:read",
      "skills:read",
      "billing:read",
      "documents:write",
      "documents:export",
      "sessions:write",
      "agents:run",
    ]));
  });

  it("does not grant document deletion through the write preset", () => {
    expect(expandScopePresets(["write"])).not.toContain("documents:delete");
  });

  it("never grants token management through preset expansion", () => {
    expect(expandScopePresets(["read", "write", "agent:run"])).not.toContain("tokens:manage");
  });

  it("filters non-delegable scopes from preset expansion", () => {
    const metadata = API_SCOPES["documents:write"];
    API_SCOPES["documents:write"] = { ...metadata, delegable: false };

    try {
      expect(expandScopePresets(["write"])).not.toContain("documents:write");
    } finally {
      API_SCOPES["documents:write"] = metadata;
    }
  });

  it("requires every requested scope", () => {
    const granted = new Set(["projects:read", "documents:read"] as const);

    expect(hasScopes(granted, ["projects:read", "documents:read"])).toBe(true);
    expect(hasScopes(granted, ["projects:read", "sessions:read"])).toBe(false);
  });
});
