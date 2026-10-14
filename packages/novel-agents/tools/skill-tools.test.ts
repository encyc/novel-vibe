import { describe, expect, it, vi } from "vitest";
import { createSkillDraftTool, createSkillEvolutionTool } from "./skill-tools.js";

const skillContent = "---\nname: Style\ndescription: Apply a style guide.\n---\n# Style\n\nPreserve narrative voice.";

describe("createSkillDraftTool", () => {
  it("creates a skill_creator draft for review instead of installing", async () => {
    const content = skillContent;
    const db = {
      createSkillDraft: vi.fn().mockResolvedValue({
        id: "d1", user_id: "u1", slug: "style", source: "skill_creator",
        original_content: content, candidate_content: content, selected_roles: ["writer"], status: "draft", version: 1,
      }),
    };
    const tool = createSkillDraftTool({ db, userId: "u1", sessionId: "session-1" } as any);
    const result = await tool.execute("c1", { slug: "style", content, roles: ["writer"] }, undefined as any, undefined);
    expect(db.createSkillDraft).toHaveBeenCalledWith(expect.objectContaining({ source: "skill_creator", sessionId: "session-1" }));
    expect(result.content[0].text).toContain("/skills?draft=d1");
  });
});

describe("createSkillEvolutionTool", () => {
  it("creates an evolution draft whose original is the live content", async () => {
    const improved = skillContent + "\n\n## Addendum\nPrefer active verbs.";
    const db = {
      findInstalledSkillBySlug: vi.fn().mockResolvedValue({ id: "skill-1", slug: "style" }),
      listSkillRoles: vi.fn().mockResolvedValue(["writer"]),
      createSkillDraft: vi.fn().mockResolvedValue({
        id: "d2", status: "draft", slug: "style",
      }),
    };
    const skillsStorage = { read: vi.fn().mockResolvedValue(skillContent) };
    const tool = createSkillEvolutionTool({ db, skillsStorage, userId: "u1", sessionId: "s1" } as any);
    const result = await tool.execute(
      "c1",
      { slug: "style", newContent: improved, rationale: "Recurring passive-voice feedback" },
      undefined as any,
      undefined,
    );
    expect(skillsStorage.read).toHaveBeenCalled();
    expect(db.createSkillDraft).toHaveBeenCalledWith(expect.objectContaining({
      source: "evolution", originalContent: skillContent, candidateContent: improved,
    }));
    expect(result.content[0].text).toContain("/skills?draft=d2");
    expect(result.details.draftId).toBe("d2");
  });

  it("refuses to evolve a skill that is not installed", async () => {
    const db = {
      findInstalledSkillBySlug: vi.fn().mockResolvedValue(null),
      listSkillRoles: vi.fn(),
      createSkillDraft: vi.fn(),
    };
    const skillsStorage = { read: vi.fn() };
    const tool = createSkillEvolutionTool({ db, skillsStorage, userId: "u1" } as any);
    const result = await tool.execute("c1", { slug: "missing", newContent: skillContent, rationale: "x" }, undefined as any, undefined);
    expect(result.isError).toBe(true);
    expect(db.createSkillDraft).not.toHaveBeenCalled();
  });
});
