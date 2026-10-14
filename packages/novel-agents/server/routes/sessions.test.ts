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
import { DEFAULT_USER, mockBody, mockReq, mockRes, mockSessionService, resetServerMocks } from "../test-kit.js";

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

describe("server sessions", () => {
  it("lists and creates durable project sessions", async () => {
      mockSessionService.listSessions.mockResolvedValue({
        items: [{ id: "s1" }],
        nextCursor: null,
        activeSessionId: "s1",
      });
      mockSessionService.createSession.mockResolvedValue({ id: "s2", title: "新会话" });

      const listReq = mockReq({
        method: "GET",
        url: "/api/projects/p1/sessions?user_id=forged-user&limit=10&search=人物",
      });
      const listRes = mockRes();
      await handleRequest(listReq as any, listRes as any);

      expect(mockSessionService.listSessions).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "p1",
        userId: DEFAULT_USER,
        limit: 10,
        search: "人物",
      }));
      expect(JSON.parse((listRes.end as any).mock.calls[0][0]).activeSessionId).toBe("s1");

      const createReq = mockReq({ method: "POST", url: "/api/projects/p1/sessions" });
      mockBody(createReq, { user_id: "forged-user" });
      const createRes = mockRes();
      await handleRequest(createReq as any, createRes as any);
      expect(mockSessionService.createSession).toHaveBeenCalledWith({ projectId: "p1", userId: DEFAULT_USER });
      expect(createRes.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
    });

  it("opens, renames, lists messages, and deletes a durable session", async () => {
      mockSessionService.openSession.mockResolvedValue({ id: "s1" });
      mockSessionService.renameSession.mockResolvedValue({ id: "s1", title: "新标题" });
      mockSessionService.listMessages.mockResolvedValue({ items: [], nextCursor: null });
      mockSessionService.deleteSession.mockResolvedValue(undefined);

      const openReq = mockReq({ method: "PATCH", url: "/api/sessions/s1" });
      mockBody(openReq, { user_id: "forged-user", action: "open" });
      await handleRequest(openReq as any, mockRes() as any);
      expect(mockSessionService.openSession).toHaveBeenCalledWith({ sessionId: "s1", userId: DEFAULT_USER });

      const renameReq = mockReq({ method: "PATCH", url: "/api/sessions/s1" });
      mockBody(renameReq, { user_id: "forged-user", title: "新标题" });
      await handleRequest(renameReq as any, mockRes() as any);
      expect(mockSessionService.renameSession).toHaveBeenCalledWith({
        sessionId: "s1",
        userId: DEFAULT_USER,
        title: "新标题",
      });

      const messagesReq = mockReq({
        method: "GET",
        url: "/api/sessions/s1/messages?user_id=forged-user&limit=20",
      });
      await handleRequest(messagesReq as any, mockRes() as any);
      expect(mockSessionService.listMessages).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "s1",
        userId: DEFAULT_USER,
        limit: 20,
      }));

      const deleteReq = mockReq({ method: "DELETE", url: "/api/sessions/s1" });
      mockBody(deleteReq, { user_id: "forged-user" });
      await handleRequest(deleteReq as any, mockRes() as any);
      expect(mockSessionService.deleteSession).toHaveBeenCalledWith({ sessionId: "s1", userId: DEFAULT_USER });
    });

  it("uses the authenticated user when session routes omit user_id", async () => {
      const req = mockReq({ method: "GET", url: "/api/projects/p1/sessions" });
      const res = mockRes();
      await handleRequest(req as any, res as any);
      expect(mockSessionService.listSessions).toHaveBeenCalledWith(expect.objectContaining({
        userId: DEFAULT_USER,
      }));
    });

  it("filters Session lists and exposes archive and restore commands", async () => {
      mockSessionService.listSessions.mockResolvedValue({ items: [], nextCursor: null, activeSessionId: null });
      mockSessionService.archiveSession.mockResolvedValue({ id: "s1", lifecycleStatus: "archived" });
      mockSessionService.restoreSession.mockResolvedValue({ id: "s1", lifecycleStatus: "active" });

      const listReq = mockReq({ method: "GET", url: "/api/projects/p1/sessions?status=archived" });
      await handleRequest(listReq as any, mockRes() as any);
      expect(mockSessionService.listSessions).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "p1",
        lifecycleStatus: "archived",
      }));

      for (const action of ["archive", "restore"] as const) {
        const req = mockReq({ method: "POST", url: `/api/sessions/s1/${action}` });
        mockBody(req, { user_id: "forged" });
        const res = mockRes();
        await handleRequest(req as any, res as any);
        expect(mockSessionService[`${action}Session`]).toHaveBeenCalledWith({
          sessionId: "s1",
          userId: DEFAULT_USER,
        });
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      }
    });

  it("interrupts a durable session with the authenticated user", async () => {
      mockSessionService.interruptSession.mockResolvedValue({ interrupted: true });
      const req = mockReq({ method: "POST", url: "/api/sessions/s1/interrupt" });
      mockBody(req, { user_id: "forged-user" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockSessionService.interruptSession).toHaveBeenCalledWith({
        sessionId: "s1",
        userId: DEFAULT_USER,
      });
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toEqual({ interrupted: true });
    });

  it("rejects invalid Session lifecycle filters", async () => {
      const req = mockReq({ method: "GET", url: "/api/projects/p1/sessions?status=trash" });
      const res = mockRes();
      await handleRequest(req as any, res as any);
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(mockSessionService.listSessions).not.toHaveBeenCalled();
    });

  it("maps session domain errors without string matching", async () => {
      mockSessionService.deleteSession.mockRejectedValueOnce(
        new SessionDomainError("MEMORY_DELETE_UNAVAILABLE", "memory offline", 503),
      );
      const req = mockReq({ method: "DELETE", url: "/api/sessions/s1" });
      mockBody(req, {});
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toMatchObject({
        error: { code: "MEMORY_DELETE_UNAVAILABLE" },
      });
    });

  it("passes the durable session identity to SessionService", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, { project_id: "proj-1", message: "Hello", session_id: "sess-1", user_id: "u1" });
      const res = mockRes();

      mockSessionService.chat.mockResolvedValue({ reply: "reply", turnId: "turn-1" });

      await handleRequest(req as any, res as any);

      expect(mockSessionService.chat).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "proj-1",
        sessionId: "sess-1",
        userId: DEFAULT_USER,
      }));
    });
});
