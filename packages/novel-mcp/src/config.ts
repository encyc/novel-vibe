export interface McpConfig {
  port: number;
  host: string;
  agentServerUrl: string;
}

export function loadConfig(env = process.env): McpConfig {
  const port = Number.parseInt(env.NOVEL_VIBE_MCP_PORT ?? "7150", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid NOVEL_VIBE_MCP_PORT");
  return {
    port,
    host: env.NOVEL_VIBE_MCP_HOST ?? "127.0.0.1",
    agentServerUrl: env.NOVEL_VIBE_AGENT_URL ?? "http://localhost:7140",
  };
}
