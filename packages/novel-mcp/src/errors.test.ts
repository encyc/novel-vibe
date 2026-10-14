import { describe, expect, it } from "vitest";
import { AgentApiError } from "./agent-client.js";
import { toToolErrorResult } from "./errors.js";

describe("toToolErrorResult", () => {
  it("carries Agent API status and payload into structured content", () => {
    const error = new AgentApiError(409, { error: "DOCUMENT_CONFLICT", content: "current body", hash: "abc123" });
    const out = toToolErrorResult(error);
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toMatchObject({ status: 409, error: "DOCUMENT_CONFLICT", hash: "abc123" });
    const block = out.content[0];
    expect(block?.type === "text" && block.text).toContain("DOCUMENT_CONFLICT");
  });

  it("falls back to string payload when upstream body is not an object", () => {
    const out = toToolErrorResult(new AgentApiError(502, "Bad gateway"));
    expect(out.structuredContent).toEqual({ status: 502, error: "Bad gateway" });
  });

  it("keeps plain messages for non-API failures like SCOPE_REQUIRED", () => {
    const out = toToolErrorResult(new Error("SCOPE_REQUIRED: documents:write"));
    expect(out.structuredContent).toEqual({ error: "SCOPE_REQUIRED: documents:write" });
    expect(out.isError).toBe(true);
  });
});
