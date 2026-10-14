import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DbClient } from "../lib/db.js";
import { BUILTIN_SKILLS, PROMPT_RESOURCE_KEYS } from "../lib/agent-resources/catalog.js";
import { PostgrestAgentResourceRepository } from "../lib/agent-resources/repository.js";
import { getAgentResourceService } from "../lib/agent-resources/runtime.js";
import type { AgentResourceIdentity, AgentResourceService } from "../lib/agent-resources/service.js";
import type { AgentResourceRepository, AgentResourceType } from "../lib/agent-resources/types.js";

interface CommandDeps {
  service: Pick<AgentResourceService, "publish" | "rollback" | "verifyRequired">;
  repository: Pick<AgentResourceRepository, "resolveActive">;
  readFile(path: URL | string, encoding: "utf8"): Promise<string>;
  writeLine(line: string): void;
}

const prompts = Object.entries(PROMPT_RESOURCE_KEYS).map(([agentId, key]) => ({
  type: "prompt" as const, key, url: new URL(`../prompts/${agentId.replaceAll("_", "-")}.md`, import.meta.url),
}));
const skills = BUILTIN_SKILLS.map(({ slug: key }) => ({
  type: "builtin_skill" as const, key, url: new URL(`../builtin/${key}/SKILL.md`, import.meta.url),
}));
const required = [...prompts, ...skills];
const hash = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

function resourceType(value: string | undefined): AgentResourceType {
  if (value !== "prompt" && value !== "builtin_skill") throw new Error("type must be prompt or builtin_skill");
  return value;
}

export async function runAgentResourceCommand(argv: string[], deps: CommandDeps): Promise<number> {
  const [command, typeArg, key, value, ...rest] = argv;
  if (command === "seed") {
    let conflicts = 0;
    for (const item of required) {
      const content = await deps.readFile(item.url, "utf8");
      const active = await deps.repository.resolveActive(item.type, item.key);
      if (!active) {
        await deps.service.publish({ type: item.type, key: item.key, content, changeNote: "bootstrap" });
        deps.writeLine(`created ${item.type}:${item.key}`);
      } else if (active.version.contentHash === hash(content)) {
        deps.writeLine(`unchanged ${item.type}:${item.key}`);
      } else {
        conflicts += 1;
        deps.writeLine(`conflict ${item.type}:${item.key}`);
      }
    }
    return conflicts ? 1 : 0;
  }
  if (command === "verify") {
    const health = await deps.service.verifyRequired(required as AgentResourceIdentity[]);
    for (const item of health.degraded) deps.writeLine(`invalid ${item.type}:${item.key} ${item.reason}`);
    return health.status === "healthy" ? 0 : 1;
  }
  if (command === "publish") {
    const type = resourceType(typeArg);
    if (!key || !value) throw new Error("publish requires type, key, and file");
    const noteIndex = rest.indexOf("--note");
    const changeNote = noteIndex >= 0 ? rest[noteIndex + 1] : undefined;
    const content = await deps.readFile(value, "utf8");
    await deps.service.publish({ type, key, content, changeNote });
    deps.writeLine(`published ${type}:${key}`);
    return 0;
  }
  if (command === "rollback") {
    const type = resourceType(typeArg);
    if (!key) throw new Error("rollback requires type and key");
    const versionNumber = Number(value);
    if (!Number.isInteger(versionNumber) || versionNumber <= 0) throw new Error("version must be a positive integer");
    await deps.service.rollback(type, key, versionNumber);
    deps.writeLine(`rolled-back ${type}:${key} v${versionNumber}`);
    return 0;
  }
  throw new Error("usage: resources <seed|verify|publish|rollback>");
}

async function main(): Promise<void> {
  const db = DbClient.forSystem();
  const code = await runAgentResourceCommand(process.argv.slice(2), {
    service: getAgentResourceService(),
    repository: new PostgrestAgentResourceRepository(db),
    readFile,
    writeLine: console.log,
  });
  process.exitCode = code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
