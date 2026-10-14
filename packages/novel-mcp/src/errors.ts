import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AgentApiError } from "./agent-client.js";

export function toToolErrorResult(error: unknown): CallToolResult {
  if (error instanceof AgentApiError) {
    const payload = error.payload && typeof error.payload === "object" && !Array.isArray(error.payload)
      ? error.payload as Record<string, unknown>
      : { error: String(error.payload) };
    const structured = { status: error.status, ...payload };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
  };
}
