import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSkillCreatorPrompt, parseChatCommand } from "./creator-command.js";

describe("built-in skill creator command", () => {
  it("recognizes only the official structured command", () => {
    expect(parseChatCommand({ command: "skill-creator" })).toEqual({ type: "skill-creator" });
    expect(parseChatCommand({ command: "user-defined" })).toBeNull();
    expect(parseChatCommand({ message: "/skill-creator" })).toBeNull();
  });

  it("builds a Chief Editor prompt that creates a review draft, never an installed Skill", () => {
    const prompt = buildSkillCreatorPrompt("Create a mystery plotting guide");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("skill-creator");
    expect(prompt).toContain("draft");
    expect(prompt).not.toContain("install directly");
  });

  it("localizes the built-in to a single-file, no-script policy", () => {
    const skill = readFileSync(new URL("../builtin/skill-creator/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain("single `SKILL.md`");
    expect(skill).toContain("name` and `description`");
    expect(skill).toContain("Never create or execute scripts");
    expect(skill).toContain("platform-provided tools");
    expect(skill).not.toContain("Bundled Resources (optional)");
    expect(skill).not.toContain("references/xxx.md");
  });
});
