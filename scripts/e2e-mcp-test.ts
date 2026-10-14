import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:7150/mcp";
const token = process.env.MCP_API_TOKEN;
if (!token) throw new Error("MCP_API_TOKEN is required");

const client = new Client({ name: "novel-vibe-e2e", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));

try {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const required of [
    "list_projects", "read_document", "write_document", "list_sessions", "run_agent",
    "respond_interaction", "interrupt_session", "list_document_versions", "list_tasks",
  ]) {
    if (!names.includes(required)) throw new Error(`Missing MCP tool: ${required}`);
  }
  for (const forbidden of ["read_doc", "write_doc", "delete_doc", "delegate_to_agent", "load_skill"]) {
    if (names.includes(forbidden)) throw new Error(`Internal Agent tool leaked: ${forbidden}`);
  }
  const projects = await client.callTool({ name: "list_projects", arguments: { status: "active" } });
  if (projects.isError) throw new Error("list_projects returned an MCP tool error");
  console.log(`MCP E2E passed (${tools.length} tools)`);
} finally {
  await client.close();
}
