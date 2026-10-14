import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { handleRequest } from "./server.js";
import { documentWrites } from "../lib/document-write-coordinator.js";
import { signTestToken } from "../lib/auth.js";
import { SessionTurnInterruptedError } from "../session/service.js";
import { SessionDomainError } from "../session/types.js";
import { sha256Content } from "../lib/storage.js";
import { VersionedDocumentWriter } from "../document-version/service.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { mockDbInstance, mockModelResolve, mockNoBody, mockRawBody, mockReq, mockRes, mockResourceHealth, resetServerMocks } from "./test-kit.js";

vi.mock("../lib/agent-resources/runtime.js", () => import("./test-kit.js").then((k) => k.agentResourcesMockFactory()));
vi.mock("../model-runtime/system-resolver.js", () => import("./test-kit.js").then((k) => k.modelResolverMockFactory()));
vi.mock("../auth/api-token-repository.js", () => import("./test-kit.js").then((k) => k.apiTokenRepoMockFactory()));
vi.mock("../lib/db.js", () => import("./test-kit.js").then((k) => k.dbMockFactory()));
vi.mock("../lib/storage.js", (importOriginal) => import("./test-kit.js").then((k) => k.storageMockFactory(importOriginal)));
vi.mock("../agents.js", () => import("./test-kit.js").then((k) => k.agentsMockFactory()));
vi.mock("../session/service.js", () => import("./test-kit.js").then((k) => k.sessionServiceMockFactory()));
vi.mock("../lib/frontmatter.js", () => import("./test-kit.js").then((k) => k.frontmatterMockFactory()));
vi.mock("../lib/skills.js", () => import("./test-kit.js").then((k) => k.skillsMockFactory()));
vi.mock("../skills/runtime.js", () => import("./test-kit.js").then((k) => k.skillReviewMockFactory()));

beforeEach(async () => {
  await resetServerMocks();
});

describe("server core", () => {
  it("wires the document version repair worker into startup and shutdown", () => {
      const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
      expect(source).toContain("startDocumentVersionRepairWorker(");
      // The repair worker must be scoped to one project and use system storage
      // credentials, and it must obtain its store through the single backend
      // factory rather than constructing a transport client directly.
      expect(source).toMatch(
        /storageForProject: \(projectId\) => createContentStore\(\{[\s\S]*?token: runtime\.db\.storageToken,[\s\S]*?projectId,[\s\S]*?\}\)/,
      );
      expect(source).toMatch(/Promise\.all\(\[[^\]]*stopDocumentVersionRepairWorker\(\)/s);
    });

  it("keeps continuity execution behind a dedicated worker boundary", () => {
      const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
      // The composition root must supply the policy ports: `continuity/` is creation-core
      // and must not reach for the SaaS billing or membership implementations itself.
      expect(source).toMatch(
        /createSystemContinuityExecutor\(runtime\.db, \{[\s\S]*?billing: new CreditBillingClient\(runtime\.db\),[\s\S]*?entitlements: createEntitlementPort\(/,
      );
      expect(source).toContain("startContinuityWorker(new ContinuityWorker(");
      expect(source).toMatch(/Promise\.all\(\[[^\]]*stopContinuityWorker\(\)/s);
    });

  it("responds to OPTIONS with CORS headers", async () => {
      const req = mockReq({ method: "OPTIONS" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(204, expect.objectContaining({
        "Access-Control-Allow-Origin": "*",
      }));
    });

  it("returns health status on GET /api/health", async () => {
      const req = mockReq({ method: "GET", url: "/api/health", headers: {} });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        "Content-Type": "application/json",
      }));
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.status).toBe("ok");
      expect(body.resources).toEqual({ status: "healthy", degraded: [] });
    });

  it("hides an exact price row when no built-in or active dynamic runtime can resolve it", async () => {
      mockDbInstance.listCreditRates.mockResolvedValueOnce([
        {
          model_pattern: "builtin-model", name: "Built in", provider_pattern: "opencode",
          input_rate: "0.1", output_rate: "0.2", is_active: true,
        },
        {
          model_pattern: "orphan-price", name: "Orphan", provider_pattern: "opencode",
          input_rate: "0.1", output_rate: "0.2", is_active: true,
        },
      ]);
      mockModelResolve.mockImplementationOnce(async () => ({ model: {}, source: "pi-ai" }));
      mockModelResolve.mockRejectedValueOnce(new Error("model not found"));
      const res = mockRes();

      await handleRequest(mockReq({ method: "GET", url: "/api/models", headers: {} }) as any, res as any);

      expect(JSON.parse((res.end as any).mock.calls[0][0]).models).toEqual([
        expect.objectContaining({ id: "builtin-model" }),
      ]);
    });

  it("reports degraded resource health without failing liveness", async () => {
      mockResourceHealth.mockReturnValueOnce({
        status: "degraded",
        degraded: [{ type: "prompt", key: "writer", reason: "missing" }],
      });
      const req = mockReq({ method: "GET", url: "/api/health", headers: {} });
      const res = mockRes();
      await handleRequest(req as any, res as any);
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.status).toBe("degraded");
      expect(body.resources.degraded[0]).toMatchObject({ type: "prompt", key: "writer" });
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

  it("returns 401 when no Bearer token provided", async () => {
      const req = mockReq({ method: "POST", url: "/api/projects", headers: {} });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.error).toEqual({
        code: "UNAUTHORIZED",
        message: "Missing Bearer token",
      });
    });

  it("returns 404 for unknown routes", async () => {
      const req = mockReq({ method: "GET", url: "/api/unknown" });
      mockNoBody(req);
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

  it("returns 400 for invalid JSON", async () => {
      const req = mockReq({ method: "POST", url: "/api/projects" });
      (req.on as any).mockImplementation((event: string, cb: Function) => {
        if (event === "error") return;
        if (event === "data") cb(Buffer.from("not-json{{{"));
        if (event === "end") cb();
      });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toEqual({
        error: { code: "INVALID_JSON", message: "Invalid JSON request body" },
      });
    });

  it("returns 413 without diagnostics when the request body exceeds 10MB", async () => {
      const req = mockReq({ method: "POST", url: "/api/projects" });
      mockRawBody(req, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(413, expect.any(Object));
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toEqual({
        error: { code: "PAYLOAD_TOO_LARGE" },
      });
    });

  it("does not expose raw exceptions in 500 responses", async () => {
      mockDbInstance.listDocuments.mockRejectedValueOnce(
        new Error("PostgREST secret schema and stack detail"),
      );
      const req = mockReq({ method: "GET", url: "/api/documents/proj-1" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body).toEqual({ error: { code: "INTERNAL_ERROR" } });
      expect(JSON.stringify(body)).not.toMatch(/PostgREST|secret|schema|stack/i);
    });
});
