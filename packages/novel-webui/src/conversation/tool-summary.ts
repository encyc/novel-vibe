import type { TraceTool } from "../assistant/chat-trace";

// dsh idea: variant -> title -> arg-word priority (SUMMARY_KEYS), mapped onto
// our tool surface.
const ARG_KEYS: Record<string, string[]> = {
  read_doc: ["path"], write_doc: ["path"], delete_doc: ["path"],
  web_search: ["query"], web_fetch: ["url"],
  load_skill: ["slug"], create_skill_draft: ["slug"],
  delegate_to_agent: ["task", "instruction", "agentId"],
};

const PATH_TOOLS = new Set(["read_doc", "write_doc", "delete_doc"]);

function firstString(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstLine(value: unknown) {
  if (typeof value !== "string") return null;
  const line = value.split("\n").find((candidate) => candidate.trim()) ?? "";
  return line.trim().slice(0, 120) || null;
}

export function summarizeToolRow(tool: TraceTool): { verbKey: string; object: string; state: "running" | "ok" | "failed" } {
  const state = tool.status === "running" ? "running" : tool.status === "failed" || tool.isError ? "failed" : "ok";
  const args = (typeof tool.args === "object" && tool.args !== null ? tool.args : {}) as Record<string, unknown>;
  if (state === "failed") {
    const errorLine = firstLine(tool.result) ?? firstLine(tool.partialResult);
    if (errorLine) return { verbKey: `assistant.tools.verbs.${tool.toolName}`, object: errorLine, state };
  }
  const keys = ARG_KEYS[tool.toolName];
  if (keys) {
    const object = firstString(args, keys);
    if (object) {
      const short = PATH_TOOLS.has(tool.toolName) ? object.split("/").slice(-2).join("/") : object.slice(0, 60);
      return { verbKey: `assistant.tools.verbs.${tool.toolName}`, object: short, state };
    }
  }
  return { verbKey: "assistant.tools.verbs.generic", object: tool.toolName, state };
}
