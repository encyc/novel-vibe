import { describe, expect, it } from "vitest";
import { classifyModelFailure } from "./failure-classifier.js";

describe("classifyModelFailure", () => {
  it.each([
    [{ status: 404, code: "model_not_found", message: "The requested model does not exist" }, "model_not_found"],
    [{ status: 400, code: "tools_not_supported", message: "Tools are not supported" }, "tools_unsupported"],
    [{ status: 400, code: "unsupported_api", message: "API type is unsupported" }, "api_unsupported"],
    [{ status: 400, code: "invalid_response_schema", validatedProtocolMismatch: true, message: "Validated adapter mismatch" }, "protocol_mismatch"],
  ])("classifies a deterministic incompatibility", (error, category) => {
    expect(classifyModelFailure(error)).toMatchObject({ deterministic: true, category });
  });

  it.each([
    { status: 429, code: "rate_limit_exceeded", message: "rate limited" },
    { status: 503, code: "server_error", message: "unavailable" },
    { code: "ETIMEDOUT", message: "request timed out" },
    { code: "ENOTFOUND", message: "getaddrinfo failed" },
    { status: 401, code: "invalid_api_key", message: "unauthorized" },
    { status: 403, code: "forbidden", message: "forbidden" },
    { status: 402, code: "insufficient_balance", message: "provider balance exhausted" },
    { code: "user_insufficient_credits", message: "user balance exhausted" },
    { status: 400, code: "context_length_exceeded", message: "context too long" },
    { status: 400, code: "invalid_tool_schema", message: "tool schema invalid" },
    { status: 404, code: "not_found", message: "some unrelated resource was not found" },
    new Error("arbitrary failure"),
  ])("does not disable for transient, auth, billing, request, or ambiguous errors", (error) => {
    expect(classifyModelFailure(error).deterministic).toBe(false);
  });

  it("sanitizes and bounds the persisted summary", () => {
    const result = classifyModelFailure({
      status: 404,
      code: "model_not_found",
      message: `Bearer secret-token ${"x".repeat(2000)}`,
    });
    expect(result.summary).not.toContain("secret-token");
    expect(result.summary.length).toBeLessThanOrEqual(1000);
  });

  it("parses pi-ai's exact OpenAI provider error envelope", () => {
    expect(classifyModelFailure(new Error(
      'OpenAI API error (404): {"error":{"code":"model_not_found","message":"missing"}}',
    ))).toMatchObject({ deterministic: true, category: "model_not_found", status: 404 });
  });
});
