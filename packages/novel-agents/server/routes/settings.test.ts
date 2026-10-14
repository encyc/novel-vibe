import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleRequest } from "../../server.js";
import { DEFAULT_USER, mockBody, mockDbInstance, mockReq, mockRes, resetServerMocks } from "../test-kit.js";
import { LOCAL_MODE_ENV, LOCAL_USER_ID } from "../../lib/local-mode.js";

vi.mock("../../lib/agent-resources/runtime.js", () => import("../test-kit.js").then((k) => k.agentResourcesMockFactory()));
vi.mock("../../model-runtime/system-resolver.js", () => import("../test-kit.js").then((k) => k.modelResolverMockFactory()));
vi.mock("../../auth/api-token-repository.js", () => import("../test-kit.js").then((k) => k.apiTokenRepoMockFactory()));
vi.mock("../../lib/db.js", () => import("../test-kit.js").then((k) => k.dbMockFactory()));
vi.mock("../../lib/storage.js", (importOriginal) => import("../test-kit.js").then((k) => k.storageMockFactory(importOriginal)));
vi.mock("../../agents.js", () => import("../test-kit.js").then((k) => k.agentsMockFactory()));
vi.mock("../../session/service.js", () => import("../test-kit.js").then((k) => k.sessionServiceMockFactory()));
vi.mock("../../lib/frontmatter.js", () => import("../test-kit.js").then((k) => k.frontmatterMockFactory()));
vi.mock("../../lib/skills.js", () => import("../test-kit.js").then((k) => k.skillsMockFactory()));
vi.mock("../../skills/runtime.js", () => import("../test-kit.js").then((k) => k.skillReviewMockFactory()));

beforeEach(async () => {
  await resetServerMocks();
  process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64url");
});

describe("server llm-keys routes", () => {
  it("lists masked keys for the authenticated user", async () => {
    mockDbInstance.listActiveUserLlmKeys.mockResolvedValue([
      { provider: "deepseek", key_last4: "abcd", updated_at: "2026-09-03T00:00:00Z" },
    ]);
    const req = mockReq({ method: "GET", url: "/api/settings/llm-keys" });
    const res = mockRes();

    await handleRequest(req as any, res as any);

    expect(mockDbInstance.listActiveUserLlmKeys).toHaveBeenCalledWith(DEFAULT_USER);
    const body = JSON.parse((res.end as any).mock.calls[0][0]);
    expect(body.keys).toEqual([
      { provider: "deepseek", keyLast4: "abcd", updatedAt: "2026-09-03T00:00:00Z" },
    ]);
    expect(JSON.stringify(body)).not.toContain("encrypted_key");
  });

  it("rejects PUT without provider or api_key", async () => {
    const req = mockReq({ method: "PUT", url: "/api/settings/llm-keys" });
    mockBody(req, { provider: "deepseek" });
    const res = mockRes();

    await handleRequest(req as any, res as any);

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockDbInstance.upsertUserLlmKey).not.toHaveBeenCalled();
  });

  it("stores only ciphertext and last four characters on PUT", async () => {
    mockDbInstance.upsertUserLlmKey.mockResolvedValue({
      key_last4: "3456",
      updated_at: "2026-09-03T00:00:00Z",
    });
    const req = mockReq({ method: "PUT", url: "/api/settings/llm-keys" });
    mockBody(req, { provider: "deepseek", api_key: "sk-abcdefghijklmnopqrstuvwxyz123456" });
    const res = mockRes();

    await handleRequest(req as any, res as any);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const params = mockDbInstance.upsertUserLlmKey.mock.calls[0][0];
    expect(params.userId).toBe(DEFAULT_USER);
    expect(params.provider).toBe("deepseek");
    expect(params.encryptedKey).toMatch(/^v1:/);
    expect(params.encryptedKey).not.toContain("sk-abcdef");
    expect(params.keyLast4).toBe("3456");
  });

  it("soft-revokes via DELETE with the provider decoded", async () => {
    const req = mockReq({ method: "DELETE", url: "/api/settings/llm-keys/deepseek" });
    const res = mockRes();

    await handleRequest(req as any, res as any);

    expect(mockDbInstance.revokeUserLlmKey).toHaveBeenCalledWith(DEFAULT_USER, "deepseek");
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it("serves list/save/revoke for the local user in local mode without a profile row", async () => {
    const previousLocalMode = process.env[LOCAL_MODE_ENV];
    process.env[LOCAL_MODE_ENV] = "1";
    try {
      mockDbInstance.listActiveUserLlmKeys.mockResolvedValue([]);
      mockDbInstance.upsertUserLlmKey.mockResolvedValue({
        key_last4: "1234",
        updated_at: "2026-10-10T00:00:00Z",
      });
      mockDbInstance.revokeUserLlmKey.mockResolvedValue(true);

      const putReq = mockReq({ method: "PUT", url: "/api/settings/llm-keys" });
      mockBody(putReq, { provider: "deepseek", api_key: "sk-local-abcdefghijklmnopqrstuvwxyz" });
      const putRes = mockRes();
      await handleRequest(putReq as any, putRes as any);

      expect(putRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockDbInstance.upsertUserLlmKey.mock.calls[0][0].userId).toBe(LOCAL_USER_ID);
      // The key is sealed with a locally resolved secret, not a host env var.
      expect(mockDbInstance.upsertUserLlmKey.mock.calls[0][0].encryptedKey).toMatch(/^v1:/);

      const getRes = mockRes();
      await handleRequest(mockReq({ method: "GET", url: "/api/settings/llm-keys" }) as any, getRes as any);
      expect(mockDbInstance.listActiveUserLlmKeys).toHaveBeenCalledWith(LOCAL_USER_ID);

      const deleteRes = mockRes();
      await handleRequest(mockReq({ method: "DELETE", url: "/api/settings/llm-keys/deepseek" }) as any, deleteRes as any);
      expect(mockDbInstance.revokeUserLlmKey).toHaveBeenCalledWith(LOCAL_USER_ID, "deepseek");

      // `novel.user_llm_keys` has no FK to auth.users, so no profile row is read.
      expect(mockDbInstance.getUserProfile).not.toHaveBeenCalled();
    } finally {
      if (previousLocalMode === undefined) delete process.env[LOCAL_MODE_ENV];
      else process.env[LOCAL_MODE_ENV] = previousLocalMode;
    }
  });
});
