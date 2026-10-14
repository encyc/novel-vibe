import { describe, expect, it } from "vitest";
import { requireScopes } from "./auth.js";

describe("MCP scope authorization", () => {
  it("requires every declared scope", () => {
    expect(() => requireScopes(new Set(["projects:read"]), ["projects:read"])).not.toThrow();
    expect(() => requireScopes(new Set(["projects:read"]), ["projects:read", "documents:read"]))
      .toThrow("SCOPE_REQUIRED: documents:read");
  });
});
