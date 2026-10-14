import { describe, expect, it } from "vitest";
import type { TraceTool } from "../assistant/chat-trace";
import { summarizeToolRow } from "./tool-summary";

function tool(patch: Partial<TraceTool>): TraceTool {
  return { toolCallId: "c1", toolName: "read_doc", agentId: "writer", args: {}, status: "succeeded", ...patch };
}

describe("summarizeToolRow", () => {
  it("maps document tools to a verb plus doc path", () => {
    expect(summarizeToolRow(tool({ toolName: "write_doc", args: { path: "chapters/012.md" } })))
      .toEqual({ verbKey: "assistant.tools.verbs.write_doc", object: "chapters/012.md", state: "ok" });
    expect(summarizeToolRow(tool({ toolName: "read_doc", args: { path: "outline/卷一.md" } })).object).toBe("outline/卷一.md");
  });

  it("falls back to query or slug style args for other tools", () => {
    expect(summarizeToolRow(tool({ toolName: "web_search", args: { query: "清代漕运" } })).object).toBe("清代漕运");
    expect(summarizeToolRow(tool({ toolName: "delegate_to_agent", args: { agentId: "outliner" } })).verbKey)
      .toBe("assistant.tools.verbs.delegate_to_agent");
  });

  it("replaces the summary with the first error line on failure", () => {
    const r = summarizeToolRow(tool({ status: "failed", result: "ENOENT: no such file\n  at reader" }));
    expect(r.state).toBe("failed");
    expect(r.object).toBe("ENOENT: no such file");
  });

  it("unknown tools degrade to the raw tool name as verb object", () => {
    const r = summarizeToolRow(tool({ toolName: "mystery", args: { a: 1 } }));
    expect(r.verbKey).toBe("assistant.tools.verbs.generic");
    expect(r.object).toBe("mystery");
  });
});
