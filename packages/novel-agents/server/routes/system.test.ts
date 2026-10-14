import { beforeEach, describe, expect, it, vi } from "vitest";
import { localByokModelCatalog, modelsGet } from "./system.js";
import { mockDbInstance, mockModelResolve, mockReq, mockRes, resetServerMocks } from "../test-kit.js";
import {
  BYOK_ALLOWED_PROVIDERS,
  BYOK_PROVIDER_PREFIX,
  splitByokProvider,
} from "../../lib/byok.js";
import { LOCAL_MODE_ENV } from "../../lib/local-mode.js";

vi.mock("../../lib/agent-resources/runtime.js", () => import("../test-kit.js").then((k) => k.agentResourcesMockFactory()));
vi.mock("../../model-runtime/system-resolver.js", () => import("../test-kit.js").then((k) => k.modelResolverMockFactory()));
vi.mock("../../lib/db.js", () => import("../test-kit.js").then((k) => k.dbMockFactory()));

async function withLocalMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env[LOCAL_MODE_ENV];
  process.env[LOCAL_MODE_ENV] = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[LOCAL_MODE_ENV];
    else process.env[LOCAL_MODE_ENV] = previous;
  }
}

async function fetchModels(): Promise<{ models: Array<Record<string, unknown>> }> {
  const res = mockRes();
  await modelsGet({
    req: mockReq({ method: "GET", url: "/api/models" }),
    res,
    url: new URL("http://localhost/api/models"),
    path: "/api/models",
  } as never);
  return JSON.parse((res.end as any).mock.calls[0][0]);
}

describe("/api/models", () => {
  beforeEach(async () => {
    await resetServerMocks();
    delete process.env[LOCAL_MODE_ENV];
  });

  it("serves the byok catalog in local mode and never reads the platform catalog", async () => {
    const body = await withLocalMode(() => fetchModels());

    expect(body.models.length).toBeGreaterThan(0);
    for (const model of body.models) {
      // Every entry must be routed through the BYOK namespace the chat path and
      // ModelResolver both understand.
      expect(typeof model.provider).toBe("string");
      expect(splitByokProvider(model.provider as string)).not.toBeNull();
      expect(String(model.provider).startsWith(BYOK_PROVIDER_PREFIX)).toBe(true);
      expect(typeof model.id).toBe("string");
      expect((model.id as string).length).toBeGreaterThan(0);
      expect(typeof model.name).toBe("string");
      expect(typeof model.providerLabel).toBe("string");
    }

    const providers = new Set(body.models.map((model) => model.provider));
    const allowed = new Set(BYOK_ALLOWED_PROVIDERS.map((base) => `${BYOK_PROVIDER_PREFIX}${base}`));
    expect([...providers].every((provider) => allowed.has(provider as string))).toBe(true);

    // The hosted catalog (credit_rates + dynamic runtime resolver) is untouched.
    expect(mockDbInstance.listCreditRates).not.toHaveBeenCalled();
    expect(mockModelResolve).not.toHaveBeenCalled();
  });

  it("keeps the hosted catalog path unchanged when local mode is off", async () => {
    mockDbInstance.listCreditRates.mockResolvedValueOnce([
      {
        model_pattern: "deepseek-chat", name: "DeepSeek Chat", provider_pattern: "deepseek",
        input_rate: "0.002", output_rate: "0.004", is_active: true,
      },
    ]);
    mockModelResolve.mockResolvedValueOnce({ model: {}, source: "pi-ai" });

    const body = await fetchModels();

    expect(mockDbInstance.listCreditRates).toHaveBeenCalledTimes(1);
    expect(body.models).toEqual([
      { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", input_rate: 2000, output_rate: 4000 },
    ]);
  });

  it("builds the local catalog from the allowlist with no database access", () => {
    const catalog = localByokModelCatalog();

    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((model) => splitByokProvider(model.provider) !== null)).toBe(true);
    expect(catalog.every((model) => model.providerLabel.length > 0)).toBe(true);
    // Vertex models need service-level credentials, not a user key.
    expect(catalog.some((model) => model.id.includes("vertex"))).toBe(false);
    expect(mockDbInstance.listCreditRates).not.toHaveBeenCalled();
  });

  it("returns the platform catalog when local mode is explicitly disabled", async () => {
    process.env[LOCAL_MODE_ENV] = "0";
    mockDbInstance.listCreditRates.mockResolvedValueOnce([]);

    const body = await fetchModels();

    expect(body.models).toEqual([]);
    expect(mockDbInstance.listCreditRates).toHaveBeenCalledTimes(1);
  });
});
