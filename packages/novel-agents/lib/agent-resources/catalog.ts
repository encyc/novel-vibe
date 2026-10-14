import { readFileSync } from "node:fs";
import type { AgentId } from "../../session/types.js";

export const PROMPT_RESOURCE_KEYS: Record<AgentId, string> = {
  chief_editor: "chief-editor",
  worldbuilder: "worldbuilder",
  character_designer: "character-designer",
  outliner: "outliner",
  director: "director",
  writer: "writer",
  script_supervisor: "script-supervisor",
};

export const BUILTIN_SKILL_SLUGS = [
  "skill-creator", "xianxia-cultivation", "xianxia-worldbuilding", "xianxia-character",
  "xianxia-plot-structure", "xianxia-battle", "xianxia-cultivation-scenes",
  "xianxia-daily-life", "xianxia-polish", "mystery-premise", "mystery-character",
  "mystery-plot-structure", "mystery-clues", "mystery-atmosphere", "mystery-interrogation",
  "mystery-deduction", "mystery-polish", "zhihu-yanxuan-polish",
] as const;

export const BUILTIN_SKILLS = BUILTIN_SKILL_SLUGS.map((slug) => ({
  slug,
  sourceFile: `builtin/${slug}/SKILL.md`,
}));
export const BUILTIN_SKILL_KEYS = new Set<string>(BUILTIN_SKILL_SLUGS);
export const REQUIRED_AGENT_RESOURCES = [
  ...Object.values(PROMPT_RESOURCE_KEYS).map((key) => ({ type: "prompt" as const, key })),
  ...BUILTIN_SKILL_SLUGS.map((key) => ({ type: "builtin_skill" as const, key })),
];

export function readPackagedPrompt(agentId: AgentId): string | null {
  try {
    return readFileSync(new URL(`../../prompts/${PROMPT_RESOURCE_KEYS[agentId]}.md`, import.meta.url), "utf8");
  } catch { return null; }
}
