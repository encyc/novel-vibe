import { describe, expect, it } from "vitest";
import { normalizeUpstreamError } from "./upstream-error.js";

describe("normalizeUpstreamError", () => {
  it("keeps only allowed fields from a nested error envelope", () => {
    expect(normalizeUpstreamError({
      error: {
        code: "SESSION_BUSY",
        message: "Session is busy",
        details: { sessionId: "s1" },
        internalTrace: "secret",
      },
      debug: "secret",
    })).toEqual({
      error: {
        code: "SESSION_BUSY",
        message: "Session is busy",
        details: { sessionId: "s1" },
      },
    });
  });

  it("converts legacy flat code, message, and details", () => {
    expect(normalizeUpstreamError({
      code: "DOCUMENT_CONFLICT",
      message: "Document conflict",
      details: { path: "text/chapter-001.md" },
      content: "private draft",
    })).toEqual({
      error: {
        code: "DOCUMENT_CONFLICT",
        message: "Document conflict",
        details: { path: "text/chapter-001.md" },
      },
    });
  });

  it.each([
    [{ error: "database password leaked" }],
    [{ message: "database password leaked" }],
    [["database password leaked"]],
  ])("replaces unstructured payloads with UPSTREAM_ERROR", (payload) => {
    expect(normalizeUpstreamError(payload)).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "The upstream service rejected the request",
      },
    });
  });
});
