import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BffClient, BffError } from "./bff-client.ts";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface MockRoute {
  match: (rec: Recorded) => boolean;
  respond: (rec: Recorded, res: ServerResponse) => void;
}

async function startMock(routes: MockRoute[]): Promise<{ server: Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const rec: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(rec);
      const route = routes.find((r) => r.match(rec));
      if (route) {
        route.respond(rec, res);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_MOCKED", message: rec.url } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

const okLogin: MockRoute = {
  match: (r) => r.method === "POST" && r.url === "/api/auth",
  respond: (_r, res) =>
    json(res, 200, { ok: true }, { "set-cookie": "novel_session=abc.def; HttpOnly; SameSite=Strict; Path=/" }),
};

describe("BffClient", () => {
  it("login stores the session cookie and sends it on later requests", async () => {
    const { server, url, requests } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "GET" && r.url === "/api/documents/p1",
        respond: (_r, res) => json(res, 200, { documents: [] }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("bench@example.com", "pw");
    expect(client.authenticated).toBe(true);
    await client.listDocuments("p1");
    const later = requests.find((r) => r.url.startsWith("/api/documents/"));
    expect(later?.headers.cookie).toBe("novel_session=abc.def");
    server.close();
  });

  it("createProject posts JSON and returns the project", async () => {
    const { server, url, requests } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "POST" && r.url === "/api/projects",
        respond: (_r, res) => json(res, 200, { project: { id: "prj-1" } }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("bench@example.com", "pw");
    const project = await client.createProject({ title: "bench/run1/L001", genre: "都市", synopsis: "s" });
    expect(project.id).toBe("prj-1");
    const rec = requests.find((r) => r.url === "/api/projects");
    expect(JSON.parse(rec!.body)).toEqual({ title: "bench/run1/L001", genre: "都市", synopsis: "s" });
    server.close();
  });

  it("createSession returns session id", async () => {
    const { server, url } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "POST" && r.url === "/api/projects/p1/sessions",
        respond: (_r, res) => json(res, 201, { session: { id: "sess-1" } }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("b@e.com", "pw");
    const session = await client.createSession("p1");
    expect(session.id).toBe("sess-1");
    server.close();
  });

  it("readDocument passes the doc path through and returns content", async () => {
    const { server, url } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "GET" && r.url.startsWith("/api/documents/p1/") && r.url.includes("ch-001.md"),
        respond: (_r, res) => json(res, 200, { content: "# 第一章", hash: "h", path: "text/ch-001.md" }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("b@e.com", "pw");
    const content = await client.readDocument("p1", "text/ch-001.md");
    expect(content).toBe("# 第一章");
    server.close();
  });

  it("listDocuments forwards ?type= filter", async () => {
    const { server, url, requests } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "GET" && r.url === "/api/documents/p1?type=chapter-text",
        respond: (_r, res) => json(res, 200, { documents: [{ doc_path: "text/ch-001.md", doc_type: "chapter-text" }] }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("b@e.com", "pw");
    const docs = await client.listDocuments("p1", "chapter-text");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.doc_type).toBe("chapter-text");
    void requests;
    server.close();
  });

  it("writeDocument sends content with empty base_hash", async () => {
    const { server, url, requests } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "PUT" && r.url.startsWith("/api/documents/p1/") && r.url.includes("core.md"),
        respond: (_r, res) => json(res, 200, { ok: true, changed: true, hash: "x", path: "worldview/core.md", indexed: true }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("b@e.com", "pw");
    await client.writeDocument("p1", "worldview/core.md", "---\ntype: worldview\n---\n正文");
    const rec = requests.find((r) => r.method === "PUT");
    expect(JSON.parse(rec!.body)).toEqual({ content: "---\ntype: worldview\n---\n正文", base_hash: "" });
    server.close();
  });

  it("normalizes upstream error bodies into BffError", async () => {
    const { server, url } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "POST" && r.url === "/api/projects",
        respond: (_r, res) => json(res, 403, { error: { code: "PROJECT_LIMIT_REACHED", message: "非会员最多创建 3 个项目" } }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("b@e.com", "pw");
    await expect(client.createProject({ title: "t", genre: "g", synopsis: "s" })).rejects.toMatchObject({
      status: 403,
      code: "PROJECT_LIMIT_REACHED",
    });
    server.close();
  });

  it("trashProject trash-then-permanent deletes", async () => {
    const { server, url, requests } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "POST" && r.url === "/api/projects/p1/trash",
        respond: (_r, res) => json(res, 200, { ok: true }),
      },
      {
        match: (r) => r.method === "DELETE" && r.url === "/api/projects/p1/permanent",
        respond: (_r, res) => json(res, 200, { ok: true }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("b@e.com", "pw");
    await client.trashProject("p1");
    const methods = requests.filter((r) => r.url.includes("/p1/")).map((r) => r.method);
    expect(methods).toEqual(["POST", "DELETE"]);
    server.close();
  });

  it("creditsActivity returns day rows", async () => {
    const { server, url, requests } = await startMock([
      okLogin,
      {
        match: (r) => r.method === "GET" && r.url.startsWith("/api/credits/activity?year="),
        respond: (_r, res) => json(res, 200, { days: [{ date: "2026-09-05", creditsConsumed: 0, totalTokens: 1234 }] }),
      },
    ]);
    const client = new BffClient(url);
    await client.login("b@e.com", "pw");
    const days = await client.creditsActivity();
    expect(days[0]?.totalTokens).toBe(1234);
    expect(requests.find((r) => r.url.includes("year="))?.url).toContain("timezone=Asia/Shanghai");
    server.close();
  });

  it("throws BffError on 401 with unauthenticated client", async () => {
    const { server, url } = await startMock([
      {
        match: (r) => r.method === "GET" && r.url === "/api/credits/activity",
        respond: (_r, res) => json(res, 401, { error: { code: "UNAUTHORIZED", message: "no session" } }),
      },
    ]);
    const client = new BffClient(url);
    await expect(client.creditsActivity()).rejects.toBeInstanceOf(BffError);
    server.close();
  });
});
