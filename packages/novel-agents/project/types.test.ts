import { describe, expect, it } from "vitest";
import { ProjectDomainError } from "./types.js";

describe("ProjectDomainError", () => {
  it("preserves stable code, status, and details", () => {
    const error = new ProjectDomainError("RESOURCE_BUSY", "busy", 409, { sessionId: "s1" });
    expect(error).toMatchObject({
      code: "RESOURCE_BUSY",
      message: "busy",
      status: 409,
      details: { sessionId: "s1" },
    });
  });
});
