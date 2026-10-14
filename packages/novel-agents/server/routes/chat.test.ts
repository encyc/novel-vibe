import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { handleRequest } from "../../server.js";
import { documentWrites } from "../../lib/document-write-coordinator.js";
import { signTestToken } from "../../lib/auth.js";
import { __setWriters } from "../../lib/logger.js";
import { SessionTurnInterruptedError } from "../../session/service.js";
import { SessionDomainError } from "../../session/types.js";
import { sha256Content } from "../../lib/storage.js";
import { VersionedDocumentWriter } from "../../document-version/service.js";
import { parseFrontmatter } from "../../lib/frontmatter.js";
import { DEFAULT_USER, mockBody, mockDbInstance, mockReq, mockRes, mockSessionService, resetServerMocks } from "../test-kit.js";
import { encryptByokSecret } from "../../lib/crypto.js";

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

describe("server chat", () => {
  it("streams normalized trace events and emits turn_complete", async () => {
      mockSessionService.chat.mockImplementation(async ({ traceSink, onTurnStarted }: any) => {
        onTurnStarted({ turnId: "turn-1", assistantMessageId: "reply-1" });
        traceSink({ type: "agent_start", agentId: "chief_editor" });
        traceSink({
          type: "message_update",
          agentId: "chief_editor",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "回答", partial: {} },
        });
        return { reply: "回答", turnId: "turn-1" };
      });
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        user_id: "forged-user",
        project_id: "p1",
        session_id: "s1",
        message: "继续",
      });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockSessionService.chat).toHaveBeenCalledWith(expect.objectContaining({
        userId: DEFAULT_USER,
      }));

      const frames = (res.write as any).mock.calls.map((call: unknown[]) => String(call[0])).join("");
      expect(frames).toContain('"type":"turn_started"');
      expect(frames).toContain('"type":"run_started"');
      expect(frames).toContain('"type":"agent_started"');
      expect(frames).toContain('"type":"answer_delta"');
      expect(frames).toContain('"type":"answer_finished"');
      expect(frames).toContain('"type":"run_finished"');
      expect(frames).toContain('"type":"turn_complete"');
      expect(frames).toContain('"assistant_message_id":"reply-1"');
      expect(frames).not.toContain('"type":"message_update"');
      expect(mockDbInstance.patchSessionMessageRow).toHaveBeenCalledWith(
        "reply-1",
        expect.objectContaining({ metadata: { trace: expect.objectContaining({ status: "succeeded" }) } }),
      );
    });

  it("accepts a typed interaction response without a free-form chat message", async () => {
      const interactionResponse = {
        schemaVersion: 1,
        interactionId: "interaction-1",
        idempotencyKey: "key-1",
        answers: [{ fieldId: "tone", type: "radio", value: "warm" }],
        freeAnswer: "Keep it restrained.",
      };
      mockSessionService.chat.mockImplementation(async ({ onTurnStarted }: any) => {
        onTurnStarted({ turnId: "turn-2", assistantMessageId: "reply-2" });
        return { reply: "Continuing", turnId: "turn-2" };
      });
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, { project_id: "p1", session_id: "s1", interaction_response: interactionResponse });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(mockSessionService.chat).toHaveBeenCalledWith(expect.objectContaining({
        interactionResponse,
        message: expect.stringContaining('"interactionId":"interaction-1"'),
      }));
      const frames = (res.write as any).mock.calls.map((call: unknown[]) => String(call[0])).join("");
      expect(frames).toContain('"type":"interaction_resolved"');
      expect(frames).toContain('"freeAnswer":"Keep it restrained."');
    });

  it("returns 400 when project_id or message missing from chat", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, { project_id: "p1" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

  it("streams chat response with SSE headers", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        message: "Hello",
        session_id: "sess-1",
        user_id: "u1",
      });
      const res = mockRes();

      mockSessionService.chat.mockResolvedValue({ reply: "Hello, writer!", turnId: "turn-1" });

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      }));

      // Durable chat terminates with a structured completion event.
      const writeCalls = (res.write as any).mock.calls;
      const replyCall = writeCalls.find((c: any) => c[0].includes('"type":"turn_complete"'));
      expect(replyCall).toBeDefined();
    });

  it("adds only the active document path to chat context", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        user_id: "u1",
        message: "继续写作",
        active_document_path: "text/chapter-001.md",
      });
      const res = mockRes();
      mockSessionService.chat.mockResolvedValue({ reply: "收到", turnId: "turn-1" });

      await handleRequest(req as any, res as any);

      expect(mockSessionService.chat).toHaveBeenCalledWith(expect.objectContaining({
        message: '<active_document path="text/chapter-001.md" />\n继续写作',
      }));
    });

  it("uses the stored project creative language and ignores the chat body", async () => {
      mockDbInstance.getProject.mockResolvedValue({
        id: "proj-1",
        lifecycle_status: "active",
        creative_language: "zh-CN",
      });
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        message: "Continue",
        creative_language: "en",
      });
      const res = mockRes();
      mockSessionService.chat.mockResolvedValue({ reply: "收到", turnId: "turn-1" });

      await handleRequest(req as any, res as any);

      expect(mockSessionService.chat).toHaveBeenCalledWith(expect.objectContaining({
        creativeLanguage: "zh-CN",
      }));
    });

  it("accepts the official structured skill-creator chat command", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, { project_id: "proj-1", session_id: "sess-1", command: "skill-creator" });
      const res = mockRes();
      mockSessionService.chat.mockResolvedValueOnce({ turnId: "t1", assistantMessageId: "a1" });

      await handleRequest(req as any, res as any);

      expect(mockSessionService.chat).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining("official_command name=\"skill-creator\""),
      }));
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

  it("forwards agent events via SSE during chat", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        user_id: "u1",
        message: "Write chapter 1",
      });
      const res = mockRes();

      mockSessionService.chat.mockImplementation(async ({ traceSink }: any) => {
        traceSink({
          type: "message_update",
          agentId: "chief_editor",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Chapter", partial: {} },
        });
        return { reply: "Chapter written!", turnId: "turn-1" };
      });

      await handleRequest(req as any, res as any);

      const writeCalls = (res.write as any).mock.calls.map((c: any) => c[0]);
      const displayEvent = writeCalls.find((c: string) => c.includes("answer_delta"));
      expect(displayEvent).toBeDefined();
    });

  it("writes SSE error event when chat throws", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        user_id: "u1",
        message: "Hello",
      });
      const res = mockRes();

      mockSessionService.chat.mockRejectedValue(new Error("Model overloaded"));

      await handleRequest(req as any, res as any);

      const writeCalls = (res.write as any).mock.calls.map((c: any) => c[0]);
      const errorEvent = writeCalls.find((c: string) => c.includes('"type":"run_failed"'));
      expect(errorEvent).toBeDefined();
      expect(errorEvent).toContain("Model overloaded");
    });

  it("shows a free-model limit message for OpenCode free usage errors", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        user_id: "u1",
        message: "Hello",
      });
      const res = mockRes();

      mockSessionService.chat.mockRejectedValue(new Error(
        '429 {"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded."}}',
      ));

      await handleRequest(req as any, res as any);

      const frames = (res.write as any).mock.calls.map((call: any[]) => String(call[0])).join("");
      expect(frames).toContain("免费模型使用额度已达上限或当前受限，请切换付费模型。");
      expect(frames).not.toContain("账户额度不足，请充值后再试。");
    });

  it("asks for a top-up only when the user's own balance is empty", async () => {
      mockDbInstance.getCreditBalance.mockResolvedValue({
        balance: "0", total_granted: "0", total_consumed: "0", level: 1, multiplier: "2",
      });
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        user_id: "u1",
        message: "Hello",
      });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      const frames = (res.write as any).mock.calls.map((call: any[]) => String(call[0])).join("");
      expect(frames).toContain("账户额度不足，请充值后再试。");
      expect(mockSessionService.chat).not.toHaveBeenCalled();
    });

  // A funded user used to be told to top up whenever any internal or upstream
  // failure carried a billing-ish word (credit / 403 / quota / insufficient).
  it("never blames the user's wallet for a platform failure", async () => {
      const lines: string[] = [];
      const restoreWriters = __setWriters((line) => lines.push(line), (line) => lines.push(line));
      try {
        mockSessionService.chat.mockRejectedValue(new Error(
          'List credit rate time windows failed [403]: {"message":"permission denied for table credit_rate_time_windows"}',
        ));
        const req = mockReq({ method: "POST", url: "/api/chat" });
        mockBody(req, {
          project_id: "proj-1",
          session_id: "sess-1",
          user_id: "u1",
          message: "Hello",
        });
        const res = mockRes();

        await handleRequest(req as any, res as any);

        const frames = (res.write as any).mock.calls.map((call: any[]) => String(call[0])).join("");
        expect(frames).toContain("模型服务暂时不可用，请稍后重试。");
        expect(frames).not.toContain("账户额度不足");

        // The raw cause must still reach the operator log.
        const logs = lines.join("");
        expect(logs).toContain("permission denied for table credit_rate_time_windows");
        expect(logs).toContain("session sess-1");
      } finally {
        restoreWriters();
      }
    });

  it("hides upstream provider billing failures behind a neutral message", async () => {
      mockSessionService.chat.mockRejectedValue(new Error(
        '402 {"error":{"type":"insufficient_balance","message":"Insufficient Balance"}}',
      ));
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        user_id: "u1",
        message: "Hello",
      });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      const frames = (res.write as any).mock.calls.map((call: any[]) => String(call[0])).join("");
      expect(frames).toContain("模型服务暂时不可用，请稍后重试。");
      expect(frames).not.toContain("账户额度不足");
      expect(frames).not.toContain("Insufficient Balance");
    });

  it("writes a distinct SSE interruption event when the user stops a turn", async () => {
      const req = mockReq({ method: "POST", url: "/api/chat" });
      mockBody(req, {
        project_id: "proj-1",
        session_id: "sess-1",
        user_id: "u1",
        message: "Hello",
      });
      const res = mockRes();
      mockSessionService.chat.mockImplementation(async ({ onTurnStarted }: any) => {
        onTurnStarted({ turnId: "turn-1", assistantMessageId: "reply-1" });
        throw new SessionTurnInterruptedError();
      });

      await handleRequest(req as any, res as any);

      const frames = (res.write as any).mock.calls.map((call: any[]) => String(call[0])).join("");
      expect(frames).toContain('"type":"run_interrupted"');
      expect(frames).toContain("已停止生成");
      expect(frames).not.toContain('"type":"run_failed"');
      expect(mockDbInstance.patchSessionMessageRow).toHaveBeenCalledWith(
        "reply-1",
        expect.objectContaining({
          metadata: { trace: expect.objectContaining({ status: "interrupted" }) },
        }),
      );
    });
});

describe("server chat BYOK gating", () => {
  const previousCipherKey = process.env.BYOK_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64url");
  });

  const byokBody = (model?: string) => ({
    project_id: "proj-1",
    session_id: "sess-1",
    message: "Hello",
    provider: "byok-deepseek",
    ...(model ? { model } : {}),
  });

  const framesOf = (res: any) =>
    (res.write as any).mock.calls.map((call: any[]) => String(call[0])).join("");

  it("rejects byok providers for members without the byok feature", async () => {
    mockDbInstance.getActiveMembership.mockResolvedValue({
      active: true,
      features: ["unlimited_projects", "continuity"],
    });
    const req = mockReq({ method: "POST", url: "/api/chat" });
    mockBody(req, byokBody());
    const res = mockRes();

    await handleRequest(req as any, res as any);

    const frames = framesOf(res);
    expect(frames).toContain('"type":"run_failed"');
    expect(frames).toContain("自带模型密钥（BYOK）为月卡会员专属");
    expect(mockSessionService.chat).not.toHaveBeenCalled();
  });

  it("rejects byok providers when no key is saved", async () => {
    mockDbInstance.getActiveMembership.mockResolvedValue({
      active: true,
      features: ["unlimited_projects", "byok"],
    });
    mockDbInstance.findActiveUserLlmKey.mockResolvedValue(null);
    const req = mockReq({ method: "POST", url: "/api/chat" });
    mockBody(req, byokBody());
    const res = mockRes();

    await handleRequest(req as any, res as any);

    const frames = framesOf(res);
    expect(frames).toContain('"type":"run_failed"');
    expect(frames).toContain("尚未配置该模型的 API Key");
    expect(mockSessionService.chat).not.toHaveBeenCalled();
  });

  it("passes the decrypted key into service.chat for byok turns", async () => {
    mockDbInstance.getActiveMembership.mockResolvedValue({
      active: true,
      features: ["unlimited_projects", "byok"],
    });
    mockDbInstance.findActiveUserLlmKey.mockResolvedValue({
      provider: "deepseek",
      encrypted_key: encryptByokSecret("sk-plain"),
    });
    mockSessionService.chat.mockResolvedValue({ reply: "收到", turnId: "turn-1" });
    const req = mockReq({ method: "POST", url: "/api/chat" });
    mockBody(req, byokBody());
    const res = mockRes();

    await handleRequest(req as any, res as any);

    expect(mockSessionService.chat).toHaveBeenCalledWith(expect.objectContaining({
      provider: "byok-deepseek",
      byokApiKey: "sk-plain",
    }));
    expect(framesOf(res)).toContain('"type":"turn_complete"');
  });

  it("skips premium-model and balance gates for byok providers", async () => {
    mockDbInstance.getActiveMembership.mockResolvedValue({
      active: true,
      features: ["unlimited_projects", "byok"],
    });
    mockDbInstance.findActiveUserLlmKey.mockResolvedValue({
      provider: "deepseek",
      encrypted_key: encryptByokSecret("sk-plain"),
    });
    mockDbInstance.getCreditBalance.mockResolvedValue({ balance: "0", total_granted: "0", total_consumed: "0", level: 1, multiplier: "2" });
    mockSessionService.chat.mockResolvedValue({ reply: "收到", turnId: "turn-1" });
    const req = mockReq({ method: "POST", url: "/api/chat" });
    // Premium platform prefix + zero balance would fail both platform gates.
    mockBody(req, byokBody("claude-opus-4-8"));
    const res = mockRes();

    await handleRequest(req as any, res as any);

    const frames = framesOf(res);
    expect(frames).toContain('"type":"turn_complete"');
    expect(frames).not.toContain("高级模型为月卡会员专属");
    expect(frames).not.toContain("账户额度不足");
  });
});
