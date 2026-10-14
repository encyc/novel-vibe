import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { handleRequest } from "../../server.js";
import { documentWrites } from "../../lib/document-write-coordinator.js";
import { signTestToken } from "../../lib/auth.js";
import { SessionTurnInterruptedError } from "../../session/service.js";
import { SessionDomainError } from "../../session/types.js";
import { sha256Content } from "../../lib/storage.js";
import { VersionedDocumentWriter } from "../../document-version/service.js";
import { parseFrontmatter } from "../../lib/frontmatter.js";
import { mockDbInstance, mockNoBody, mockReq, mockRes, resetServerMocks } from "../test-kit.js";

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
});

describe("server tasks", () => {
  it("lists tasks on GET /api/tasks", async () => {
      const req = mockReq({ method: "GET", url: "/api/tasks?project_id=proj-1&limit=10" });
      mockNoBody(req);
      const res = mockRes();

      mockDbInstance.listTasks.mockResolvedValue([
        { id: "task-1", description: "Write chapter 1", status: "pending" },
      ]);

      await handleRequest(req as any, res as any);

      expect(mockDbInstance.listTasks).toHaveBeenCalledWith("proj-1", 10);
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body.tasks).toHaveLength(1);
    });

  it("returns 400 on GET /api/tasks without project_id", async () => {
      const req = mockReq({ method: "GET", url: "/api/tasks" });
      mockNoBody(req);
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });
});
