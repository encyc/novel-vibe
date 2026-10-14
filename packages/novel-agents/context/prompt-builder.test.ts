import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../session/types.js";
import type { SupportedLanguage } from "../lib/language.js";
import { PromptBuilder, renderLanguageContext } from "./prompt-builder.js";

function createBuilder(creativeLanguage: SupportedLanguage): PromptBuilder {
  return new PromptBuilder({
    promptLoader: async () => "BASE",
    skillLoader: async () => "",
    token: "token",
    projectId: "project-1",
    userId: "user-1",
    creativeLanguage,
  });
}

describe("PromptBuilder", () => {
  it("renders stable English and Chinese creative-language contracts", () => {
    expect(renderLanguageContext("en")).toContain("<project_language>en</project_language>");
    expect(renderLanguageContext("en")).toContain("Reply and author new novel content in English.");
    expect(renderLanguageContext("en")).toContain("current user task may override");
    expect(renderLanguageContext("en")).toContain(
      "Do not translate proper nouns when preservation is appropriate, file paths, tool names",
    );
    expect(renderLanguageContext("zh-CN")).toContain("<project_language>zh-CN</project_language>");
    expect(renderLanguageContext("zh-CN")).toContain("使用简体中文回复并创作新的小说内容");
  });

  it("injects the project language into every Agent prompt", async () => {
    const builder = createBuilder("en");
    for (const agentId of AGENT_IDS) {
      expect(await builder.build(agentId)).toContain("<project_language>en</project_language>");
    }
  });

  it("injects LINGQI.md instructions before skills and after the base prompt", async () => {
    const calls: string[] = [];
    const builder = new PromptBuilder({
      promptLoader: async () => {
        calls.push("base");
        return "BASE";
      },
      skillLoader: async () => {
        calls.push("skill");
        return "SKILLS";
      },
      instructionLoader: async () => {
        calls.push("lingqi");
        return "LINGQI_BODY";
      },
      token: "tok",
      projectId: "pid",
      userId: "uid",
    });

    const prompt = await builder.build("writer");

    // Loader call order proves placement is computed before skills.
    expect(calls).toEqual(["base", "lingqi", "skill"]);
    expect(prompt.startsWith("BASE")).toBe(true);
    expect(prompt).not.toContain("[object Promise]");
    const lingqiIdx = prompt.indexOf("LINGQI_BODY");
    const skillsIdx = prompt.indexOf("SKILLS");
    const baseIdx = prompt.indexOf("BASE");
    expect(baseIdx).toBeLessThan(lingqiIdx);
    expect(lingqiIdx).toBeLessThan(skillsIdx);
  });

  it("omits the LINGQI block when the loader returns empty", async () => {
    const builder = new PromptBuilder({
      promptLoader: () => "BASE",
      skillLoader: async () => "",
      instructionLoader: async () => "",
      token: "tok",
      projectId: "pid",
    });
    const prompt = await builder.build("writer");
    expect(prompt).not.toContain("创作指南");
    expect(prompt.startsWith("BASE")).toBe(true);
  });

  it("does not call an undefined instructionLoader (legacy/no-guide projects)", async () => {
    const builder = new PromptBuilder({
      promptLoader: () => "BASE",
      skillLoader: async () => "",
      token: "tok",
      projectId: "pid",
    });
    const prompt = await builder.build("writer");
    expect(prompt.startsWith("BASE")).toBe(true);
    expect(prompt).not.toContain("创作指南");
  });

  it("does not inject the delete/web-search protocols for chief_editor", async () => {
    const builder = new PromptBuilder({
      promptLoader: () => "BASE",
      skillLoader: async () => "",
      token: "tok",
      projectId: "pid",
    });
    const chief = await builder.build("chief_editor");
    const writer = await builder.build("writer");
    expect(chief).not.toContain("删除审批协议");
    expect(writer).toContain("删除审批协议");
  });
});
