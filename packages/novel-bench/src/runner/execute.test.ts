import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BffClient } from "./bff-client.ts";
import { executeCase } from "./execute.ts";
import type { BenchCase } from "../types.ts";

function sseComplete(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ type: "turn_started" })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "turn_complete" })}\n\n`);
  res.end();
}

function sseFailed(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ type: "turn_started" })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: "run_failed", message: "model exploded" })}\n\n`);
  res.end();
}

interface MockState {
  projects: Array<{ id: string; title: string }>;
  docs: Map<string, string>; // "pid|path" -> content
  docType: Map<string, string>;
  tokens: number;
  chatHandler: (res: ServerResponse, body: string) => void;
}

async function startFlowMock(state: MockState): Promise<{ server: Server; client: BffClient }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const respondJson = (payload: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && path === "/api/projects") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const id = `p${state.projects.length + 1}`;
        state.projects.push({ id, title: body.title });
        respondJson({ project: { id } });
      } else if (req.method === "PUT" && path.startsWith("/api/documents/")) {
        const rest = path.slice("/api/documents/".length).split("/");
        const pid = rest.shift()!;
        const docPath = decodeURIComponent(rest.join("/"));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        state.docs.set(`${pid}|${docPath}`, body.content);
        state.docType.set(`${pid}|${docPath}`, docTypeOf(docPath));
        respondJson({ ok: true, changed: true, hash: "h", path: docPath, indexed: true });
      } else if (req.method === "POST" && /\/sessions$/.test(path)) {
        respondJson({ session: { id: "s1" } }, 201);
      } else if (req.method === "POST" && path === "/api/chat/stream") {
        state.chatHandler(res, Buffer.concat(chunks).toString("utf8"));
      } else if (req.method === "GET" && /^\/api\/documents\/[^/]+$/.test(path)) {
        const pid = path.split("/").pop()!;
        const type = url.searchParams.get("type");
        const documents = [...state.docs.entries()]
          .filter(([key]) => key.startsWith(`${pid}|`))
          .filter(([key]) => !type || state.docType.get(key) === type)
          .map(([key]) => ({ doc_path: key.split("|")[1], doc_type: state.docType.get(key) }));
        respondJson({ documents });
      } else if (req.method === "GET" && path.startsWith("/api/documents/")) {
        const rest = path.slice("/api/documents/".length).split("/");
        const pid = rest.shift()!;
        const docPath = decodeURIComponent(rest.join("/"));
        const content = state.docs.get(`${pid}|${docPath}`);
        if (content === undefined) {
          respondJson({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
        } else {
          respondJson({ content, hash: "h", path: docPath });
        }
      } else if (req.method === "GET" && path === "/api/credits/activity") {
        respondJson({ days: [{ date: "2026-09-05", creditsConsumed: 0, totalTokens: state.tokens }] });
      } else {
        respondJson({ error: { code: "NOT_MOCKED", message: path } }, 404);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, client: new BffClient(`http://127.0.0.1:${port}`) };
}

function docTypeOf(docPath: string): string {
  if (docPath.startsWith("text/")) return "chapter-text";
  if (docPath.startsWith("worldview/")) return "worldview";
  if (docPath.startsWith("outline/")) return "chapter-card";
  return "misc";
}

async function writeCaseLibrary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-run-"));
  await mkdir(join(dir, "light", "fixtures"), { recursive: true });
  await writeFile(
    join(dir, "light", "fixtures", "worldview.md"),
    "---\ntype: worldview\ntitle: 测试世界观\n---\n这是一个测试世界观。",
  );
  return dir;
}

const CASE: BenchCase = {
  id: "light/LTEST",
  title: "测试案例",
  layer: "light",
  dimensionFocus: ["prose"],
  setup: [{ path: "worldview/core.md", type: "worldview", fixture: "fixtures/worldview.md" }],
  script: [
    {
      text: "请写第 1 章正文。",
      expect: { docType: "chapter-text", minCount: 1 },
    },
  ],
  constraints: { minWords: 5 },
  rubricWeights: { prose: 1 },
};

describe("executeCase", () => {
  it("runs a happy-path case: sandbox, turn, expect, collection, cost delta", async () => {
    const state: MockState = {
      projects: [],
      docs: new Map(),
      docType: new Map(),
      tokens: 100,
      chatHandler: (res, body) => {
        state.tokens += 250;
        const parsed = JSON.parse(body) as { project_id: string };
        const key = `${parsed.project_id}|text/ch-001.md`;
        state.docs.set(key, "---\ntype: chapter-text\n---\n这是正文内容，足够长。");
        state.docType.set(key, "chapter-text");
        sseComplete(res);
      },
    };
    const { server, client } = await startFlowMock(state);
    const casesDir = await writeCaseLibrary();
    const execution = await executeCase(
      { client, turnTimeoutMs: 5_000, expectPollIntervalMs: 10, expectTimeoutMs: 1_000 },
      "run1",
      CASE,
      casesDir,
    );
    expect(execution.status).toBe("complete");
    expect(execution.turns).toHaveLength(1);
    expect(execution.turns[0]?.expect).toMatchObject({ ok: true });
    expect(execution.docs).toHaveLength(2); // setup worldview + generated chapter
    expect(execution.docs.map((d) => d.type)).toContain("chapter-text");
    expect(execution.cost.tokensBefore).toBe(100);
    expect(execution.cost.tokensAfter).toBe(350);
    // project was created with bench/<runId>/<caseId> title
    expect(state.projects[0]?.title).toBe("bench/run1/light/LTEST");
    server.close();
  });

  it("marks the case failed when a turn fails and skips later steps", async () => {
    const state: MockState = {
      projects: [],
      docs: new Map(),
      docType: new Map(),
      tokens: 0,
      chatHandler: (res) => sseFailed(res),
    };
    const { server, client } = await startFlowMock(state);
    const casesDir = await writeCaseLibrary();
    const twoSteps: BenchCase = { ...CASE, script: [{ text: "一步" }, { text: "两步" }] };
    const execution = await executeCase(
      { client, turnTimeoutMs: 5_000, expectPollIntervalMs: 10, expectTimeoutMs: 200 },
      "run1",
      twoSteps,
      casesDir,
    );
    expect(execution.status).toBe("failed");
    expect(execution.turns).toHaveLength(1);
    expect(execution.error).toContain("model exploded");
    // setup docs are still collected for scoring even on failure
    expect(execution.docs).toHaveLength(1);
    server.close();
  });

  it("marks the case partial when an expectation times out", async () => {
    const state: MockState = {
      projects: [],
      docs: new Map(),
      docType: new Map(),
      tokens: 0,
      chatHandler: (res) => sseComplete(res), // completes but produces nothing
    };
    const { server, client } = await startFlowMock(state);
    const casesDir = await writeCaseLibrary();
    const execution = await executeCase(
      { client, turnTimeoutMs: 5_000, expectPollIntervalMs: 10, expectTimeoutMs: 100 },
      "run1",
      CASE,
      casesDir,
    );
    expect(execution.status).toBe("partial");
    expect(execution.turns[0]?.expect).toMatchObject({ ok: false });
    expect(execution.error).toContain("expectation unmet");
    server.close();
  });
});
