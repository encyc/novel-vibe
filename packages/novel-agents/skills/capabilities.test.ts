import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  capabilitiesForRole,
  capabilityForTool,
  checkCapabilityCompatibility,
} from "./capabilities.js";

describe("platform capability catalog", () => {
  it("maps every currently configured tool to a server-owned capability", () => {
    const tools = [
      "read_doc", "list_skills", "load_skill", "write_doc", "delete_doc", "search_docs", "list_docs",
      "chapter_context", "sync_index", "sync_all_indexes", "update_status",
      "get_project_status", "delegate_to_agent",
      "update_run_plan", "request_user_interaction",
    ];

    expect(tools.filter((tool) => !capabilityForTool(tool))).toEqual([]);
    expect(CAPABILITY_CATALOG.every((entry) => entry.id && entry.toolName)).toBe(true);
  });

  it("allows document reads for writer but not delegation", () => {
    expect(checkCapabilityCompatibility("writer", ["documents.read"]).ok).toBe(true);
    expect(checkCapabilityCompatibility("writer", ["agents.delegate"])).toEqual({
      ok: false,
      missing: ["agents.delegate"],
    });
  });

  it("does not claim unavailable web search", () => {
    expect(checkCapabilityCompatibility("chief_editor", ["web.crawl"])).toEqual({
      ok: false,
      missing: ["web.crawl"],
    });
  });

  it("keeps destructive execution exclusive to the chief editor", () => {
    expect(capabilitiesForRole("chief_editor").has("documents.delete")).toBe(true);
    expect(capabilitiesForRole("writer").has("documents.delete")).toBe(false);
    expect(capabilitiesForRole("writer").has("documents.request_delete")).toBe(true);
  });
});
