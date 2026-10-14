import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BffClient } from "./bff-client.ts";
import { runChatTurn } from "./chat-stream.ts";

function sse(res: ServerResponse, frames: Array<{ delayMs: number; data: unknown | string }>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  let elapsed = 0;
  for (const frame of frames) {
    elapsed += frame.delayMs;
    setTimeout(() => {
      const payload = typeof frame.data === "string" ? frame.data : `data: ${JSON.stringify(frame.data)}`;
      res.write(`${payload}\n\n`);
    }, elapsed);
  }
  setTimeout(() => res.end(), elapsed + 50);
}

async function startSseMock(handler: (reqBody: string, res: ServerResponse, call: number) => void): Promise<{
  server: Server;
  client: BffClient;
}> {
  let call = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      call += 1;
      handler(Buffer.concat(chunks).toString("utf8"), res, call);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, client: new BffClient(`http://127.0.0.1:${port}`) };
}

const input = { projectId: "p1", sessionId: "s1", message: "写正文", timeoutMs: 5_000 };

describe("runChatTurn", () => {
  it("resolves complete on turn_complete, ignoring keepalives and trace events", async () => {
    const { server, client } = await startSseMock((_body, res) => {
      sse(res, [
        { delayMs: 1, data: { type: "turn_started", session_id: "s1", turn_id: "t1" } },
        { delayMs: 1, data: ": keepalive" },
        { delayMs: 1, data: { version: 1, runId: "r", seq: 1, type: "tool_started", toolName: "write_doc" } },
        { delayMs: 1, data: { type: "turn_complete", session_id: "s1", turn_id: "t1" } },
      ]);
    });
    const outcome = await runChatTurn(client, input);
    expect(outcome.kind).toBe("complete");
    if (outcome.kind === "complete") {
      expect(outcome.endedAt).toBeGreaterThanOrEqual(outcome.startedAt);
    }
    server.close();
  });

  it("resolves failed on run_failed", async () => {
    const { server, client } = await startSseMock((_body, res) => {
      sse(res, [
        { delayMs: 1, data: { type: "turn_started" } },
        { delayMs: 1, data: { type: "run_failed", message: "boom" } },
      ]);
    });
    const outcome = await runChatTurn(client, input);
    expect(outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("boom") });
    server.close();
  });

  it("resolves failed when the stream ends without a terminal event", async () => {
    const { server, client } = await startSseMock((_body, res) => {
      sse(res, [{ delayMs: 1, data: { type: "turn_started" } }]);
    });
    const outcome = await runChatTurn(client, input);
    expect(outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("stream ended") });
    server.close();
  });

  it("retries 409 SESSION_BUSY then succeeds", async () => {
    const { server, client } = await startSseMock((_body, res, call) => {
      if (call === 1) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "SESSION_BUSY", message: "Session is already processing" } }));
        return;
      }
      sse(res, [{ delayMs: 1, data: { type: "turn_complete" } }]);
    });
    const outcome = await runChatTurn(client, input, { attempts: 3, backoffMs: 10 });
    expect(outcome.kind).toBe("complete");
    server.close();
  });

  it("gives up after retry attempts on persistent 409", async () => {
    const { server, client } = await startSseMock((_body, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "SESSION_BUSY", message: "busy" } }));
    });
    const outcome = await runChatTurn(client, input, { attempts: 2, backoffMs: 5 });
    expect(outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("SESSION_BUSY") });
    server.close();
  });

  it("times out a stalled stream", async () => {
    const { server, client } = await startSseMock((_body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // never writes, never ends
    });
    const outcome = await runChatTurn(client, { ...input, timeoutMs: 150 });
    expect(outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("timed out") });
    server.close();
  });

  it("aborts on stream stall even when keepalives kept it alive earlier", async () => {
    const { server, client } = await startSseMock((_body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`: keepalive\n\n`);
      setTimeout(() => res.write(`: keepalive\n\n`), 200);
      // then silence forever
    });
    const outcome = await runChatTurn(client, { ...input, timeoutMs: 30_000, stallTimeoutMs: 700 });
    expect(outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("no stream activity") });
    server.close();
  });

  it("sends project/session/message plus provider/model override", async () => {
    let seen = "";
    const { server, client } = await startSseMock((body, res) => {
      seen = body;
      sse(res, [{ delayMs: 1, data: { type: "turn_complete" } }]);
    });
    await runChatTurn(client, { ...input, provider: "deepseek", model: "deepseek-v4-flash" });
    expect(JSON.parse(seen)).toEqual({
      project_id: "p1",
      session_id: "s1",
      message: "写正文",
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    server.close();
  });
});
