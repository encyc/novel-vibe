import { beforeEach, describe, expect, it, vi } from "vitest";

// Assembled from fragments on purpose. A single long `sk-…` literal matches
// GitHub's push-protection pattern for DeepSeek keys — it did, and blocked
// publishing the repository — even though this is a fake that exists only to
// be encrypted by the test below.
const PLAINTEXT_DEEPSEEK_KEY = ["sk-", "abcdefghij", "klmnopqrst", "uvwxyz123456"].join("");

const dbMock = {
  listActiveUserLlmKeys: vi.fn(),
  findActiveUserLlmKey: vi.fn(),
  upsertUserLlmKey: vi.fn(),
  revokeUserLlmKey: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");
});

describe("ByokKeyService.save", () => {
  it("rejects providers outside the allowlist", async () => {
    const { ByokKeyService } = await import("./byok-service.js");
    const service = new ByokKeyService(dbMock as any);
    await expect(service.save("u1", "not-a-provider", "irrelevant-key-0")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects short keys without touching the db", async () => {
    const { ByokKeyService } = await import("./byok-service.js");
    const service = new ByokKeyService(dbMock as any);
    await expect(service.save("u1", "deepseek", "short")).rejects.toMatchObject({ status: 400 });
    expect(dbMock.upsertUserLlmKey).not.toHaveBeenCalled();
  });

  it("stores only ciphertext and the last four characters", async () => {
    dbMock.upsertUserLlmKey.mockResolvedValue({ key_last4: "3456", updated_at: "2026-09-03T00:00:00Z" });
    const { ByokKeyService } = await import("./byok-service.js");
    const service = new ByokKeyService(dbMock as any);
    const saved = await service.save("u1", "deepseek", PLAINTEXT_DEEPSEEK_KEY);
    expect(saved).toEqual({ provider: "deepseek", keyLast4: "3456", updatedAt: "2026-09-03T00:00:00Z" });
    const params = dbMock.upsertUserLlmKey.mock.calls[0][0];
    expect(params.encryptedKey).toMatch(/^v1:/);
    expect(params.encryptedKey).not.toContain("sk-abcdef");
  });
});

describe("ByokKeyService.list", () => {
  it("returns masked rows only", async () => {
    dbMock.listActiveUserLlmKeys.mockResolvedValue([
      { provider: "deepseek", key_last4: "abcd", updated_at: "2026-09-03T00:00:00Z" },
    ]);
    const { ByokKeyService } = await import("./byok-service.js");
    const service = new ByokKeyService(dbMock as any);
    expect(await service.list("u1")).toEqual([
      { provider: "deepseek", keyLast4: "abcd", updatedAt: "2026-09-03T00:00:00Z" },
    ]);
  });
});

describe("ByokKeyService.resolveKey", () => {
  it("decrypts the stored key for the caller", async () => {
    const { encryptByokSecret } = await import("./crypto.js");
    dbMock.findActiveUserLlmKey.mockResolvedValue({
      provider: "deepseek",
      encrypted_key: encryptByokSecret("sk-resolve-me"),
    });
    const { ByokKeyService } = await import("./byok-service.js");
    const service = new ByokKeyService(dbMock as any);
    expect(await service.resolveKey("u1", "deepseek")).toBe("sk-resolve-me");
  });
});

describe("ByokKeyService.config", () => {
  it("reports enabled=false without the encryption key", async () => {
    delete process.env.BYOK_ENCRYPTION_KEY;
    const { ByokKeyService } = await import("./byok-service.js");
    const service = new ByokKeyService(dbMock as any);
    const config = await service.config();
    expect(config.enabled).toBe(false);
    expect(config.providers).toEqual([]);
  });

  it("lists allowlisted providers with builtin model catalogs", async () => {
    const { ByokKeyService } = await import("./byok-service.js");
    const service = new ByokKeyService(dbMock as any);
    const config = await service.config();
    expect(config.enabled).toBe(true);
    const byId = new Map(config.providers.map((provider) => [provider.id, provider]));
    expect(byId.get("deepseek")?.models.length).toBeGreaterThan(0);
    expect(byId.get("openai")?.models.length).toBeGreaterThan(0);
    // 智谱 GLM 与小米 MiMo（含 Token 计划端点）必须可选，且带中文展示名。
    expect(byId.get("zai-coding-cn")?.label).toBe("智谱 GLM（Coding 计划）");
    expect(byId.get("zai")?.label).toBe("智谱 GLM Coding（国际）");
    expect(byId.get("xiaomi")?.label).toBe("小米 MiMo");
    expect(byId.get("xiaomi-token-plan-cn")?.label).toBe("小米 MiMo（Token 计划）");
    expect(byId.get("xiaomi")?.models.map((model) => model.id)).toContain("mimo-v2.5-pro");
    expect(byId.get("xiaomi-token-plan-cn")?.models.map((model) => model.id)).toContain("mimo-v2.5-pro");
    expect(byId.get("zai-coding-cn")?.models.map((model) => model.id)).toContain("glm-5.3");
  });
});
