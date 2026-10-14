import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditService } from "./audit-service.js";

describe("AuditService", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records bounded metadata without credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const db = { pgToken: "system-jwt" } as any;
    await new AuditService(db, "http://postgrest").record({
      userId: "user-1", tokenId: "token-1", operation: "agent.run", status: "accepted",
      projectId: "project-1", sessionId: "session-1", metadata: { model: "deepseek" },
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      user_id: "user-1", token_id: "token-1", operation: "agent.run", status: "accepted",
    }));
    expect(String(init.body)).not.toContain("system-jwt");
  });
});
