import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AgentClient } from "./agent-client.js";
import { McpAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { requestContext } from "./context.js";
import { registerTools } from "./tools.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { AuditService } from "../../novel-agents/auth/audit-service.js";
import { DbClient } from "../../novel-agents/lib/db.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) });
  res.end(encoded);
}

export function createMcpHandler(options: {
  agentServerUrl: string;
  authenticator?: Pick<McpAuthenticator, "authenticate">;
}) {
  const authenticator = options.authenticator ?? new McpAuthenticator();
  const client = new AgentClient(options.agentServerUrl);
  const requestLimiter = new FixedWindowRateLimiter(120, 60_000);
  const agentLimiter = new FixedWindowRateLimiter(10, 60_000);
  const audit = process.env.JWT_SECRET ? new AuditService(DbClient.forSystem()) : undefined;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health" && req.method === "GET") return json(res, 200, { ok: true });
    if (path !== "/mcp") return json(res, 404, { error: "Not found" });
    if (!new Set(["GET", "POST", "DELETE"]).has(req.method ?? "")) return json(res, 405, { error: "Method not allowed" });

    let context;
    try {
      context = await authenticator.authenticate(req.headers.authorization);
    } catch {
      return json(res, 401, { error: "AUTH_INVALID" });
    }
    if (!context) return json(res, 401, { error: "AUTH_INVALID" });
    try { requestLimiter.check(context.principal.tokenId); } catch { return json(res, 429, { error: "RATE_LIMITED", retryable: true }); }

    return requestContext.run(context, async () => {
      const mcp = new McpServer({ name: "novel-vibe", version: "0.1.0" });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      registerTools(mcp, client, agentLimiter, audit);
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) json(res, 500, { error: "INTERNAL_ERROR" });
      } finally {
        await transport.close().catch(() => {});
        await mcp.close().catch(() => {});
      }
    });
  };
}

export const server = process.env.NODE_ENV === "test" ? null : (() => {
  const config = loadConfig();
  const instance = createServer(createMcpHandler({ agentServerUrl: config.agentServerUrl }));
  instance.listen(config.port, config.host, () => {
    console.log(`[mcp] listening on http://${config.host}:${config.port}/mcp`);
  });
  return instance;
})();
