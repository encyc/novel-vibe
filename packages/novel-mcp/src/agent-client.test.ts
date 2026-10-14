import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient, AgentApiError } from "./agent-client.js";

describe("AgentClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards delegated bearer credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new AgentClient("http://agent").request("jwt", "/api/projects")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("http://agent/api/projects", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer jwt" }),
    }));
  });

  it("maps upstream failures without exposing credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad" }), { status: 403 })));
    await expect(new AgentClient("http://agent").request("secret-jwt", "/api/projects"))
      .rejects.toBeInstanceOf(AgentApiError);
  });

  function sseResponse(frames: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("surfaces the run_failed reason when the stream ends before turn_started", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ type: "run_failed", message: "高级模型为月卡会员专属，请开通月卡或切换其他模型。" })}\n\n`,
    ])));
    await expect(new AgentClient("http://agent").startAgentRun("jwt", {}))
      .rejects.toThrow("高级模型为月卡会员专属");
  });

  it("resolves on turn_started and cancels the stream instead of holding it", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "turn_started", turn_id: "t1", assistant_message_id: "m1" })}\n\n`));
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    const event = await new AgentClient("http://agent").startAgentRun("jwt", {});
    expect(event).toMatchObject({ type: "turn_started", turn_id: "t1" });
    expect(cancelled).toBe(true);
  });

  it("skips keepalive comment frames while waiting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([
      ": keepalive\n\n",
      `data: ${JSON.stringify({ type: "run_failed", message: "账户额度不足，请充值后再试。" })}\n\n`,
    ])));
    await expect(new AgentClient("http://agent").startAgentRun("jwt", {})).rejects.toThrow("账户额度不足");
  });

  it("keeps the upstream failure payload when the chat POST rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "SESSION_BUSY" }), { status: 409 })));
    const error = await new AgentClient("http://agent").startAgentRun("secret-jwt", {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AgentApiError);
    expect((error as AgentApiError).payload).toEqual({ error: "SESSION_BUSY" });
  });
});
