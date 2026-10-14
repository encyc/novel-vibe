import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ToolContext } from "./file-tools.js";
import { validateSkill } from "../skills/policy.js";
import { skillFilePath } from "../lib/skills.js";

const roleSchema = Type.Union([
  Type.Literal("chief_editor"), Type.Literal("worldbuilder"), Type.Literal("character_designer"),
  Type.Literal("outliner"), Type.Literal("director"), Type.Literal("writer"), Type.Literal("script_supervisor"),
]);
const paramsSchema = Type.Object({
  slug: Type.String(),
  content: Type.String({ description: "Complete single-file SKILL.md content" }),
  roles: Type.Array(roleSchema, { minItems: 1 }),
});

export function createSkillDraftTool(ctx: ToolContext): AgentTool<typeof paramsSchema> {
  return {
    name: "create_skill_draft",
    label: "Create Skill Review Draft",
    description: "Create a user-owned SKILL.md draft for mandatory review and confirmation. This never installs a Skill.",
    parameters: paramsSchema,
    executionMode: "sequential",
    execute: async (_, params) => {
      if (!ctx.userId) {
        return { content: [{ type: "text", text: "Cannot create a Skill draft without an authenticated user." }], details: { error: "unauthenticated" }, isError: true };
      }
      const validation = validateSkill({ slug: params.slug, content: params.content, roles: params.roles });
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: `Skill draft rejected: ${validation.issues.map((issue) => issue.message).join("; ")}` }],
          details: { issues: validation.issues },
          isError: true,
        };
      }
      const row = await ctx.db.createSkillDraft({
        userId: ctx.userId,
        slug: params.slug,
        source: "skill_creator",
        originalContent: params.content,
        candidateContent: params.content,
        selectedRoles: params.roles,
        sessionId: ctx.sessionId,
      });
      return {
        content: [{ type: "text", text: `Skill draft created. Open /skills?draft=${row.id} to review it. It is not installed yet.` }],
        details: { draftId: row.id, status: row.status, reviewUrl: `/skills?draft=${row.id}` },
      };
    },
  };
}

const evolutionParamsSchema = Type.Object({
  slug: Type.String({ description: "Slug of the already-installed USER skill to improve" }),
  newContent: Type.String({ description: "Complete improved SKILL.md content (full file, not a diff)" }),
  rationale: Type.String({ description: "Why this improvement is needed — surfaced to the user in the review UI" }),
});

/**
 * Self-evolution tool: read the currently-installed USER skill, create an
 * evolution draft whose original = the live version (so the review UI shows a
 * meaningful diff), then tell the Chief Editor to point the user at the review
 * link. The draft still goes through the standard review → user-confirm flow;
 * this tool never installs or updates a skill directly.
 */
export function createSkillEvolutionTool(ctx: ToolContext): AgentTool<typeof evolutionParamsSchema> {
  return {
    name: "propose_skill_evolution",
    label: "Propose Skill Evolution",
    description:
      "Propose an improvement to an already-installed USER skill. Reads the live version, validates the new content, and creates a review draft awaiting user confirmation. Built-in skills cannot be evolved (they ship with the app). This never installs the change — the user must confirm it on the /skills review page.",
    parameters: evolutionParamsSchema,
    executionMode: "sequential",
    execute: async (_, params) => {
      if (!ctx.userId) {
        return { content: [{ type: "text", text: "Cannot propose a Skill evolution without an authenticated user." }], details: { error: "unauthenticated" }, isError: true };
      }
      const installed = await ctx.db.findInstalledSkillBySlug(ctx.userId, params.slug);
      if (!installed) {
        return {
          content: [{ type: "text", text: `Skill "${params.slug}" is not installed for this user, or is a built-in skill that cannot be evolved.` }],
          details: { slug: params.slug, error: true },
          isError: true,
        };
      }
      // Read the live content so the review diff shows original → candidate.
      let currentContent = "";
      try {
        currentContent = await ctx.skillsStorage.read(skillFilePath(params.slug, "user", ctx.userId));
      } catch {
        return {
          content: [{ type: "text", text: `Could not read the live content of skill "${params.slug}" from storage.` }],
          details: { slug: params.slug, error: true },
          isError: true,
        };
      }
      const roles = await ctx.db.listSkillRoles(installed.id);
      const roleList = (roles.length > 0 ? roles : ["chief_editor"]) as typeof roleSchema[number][] as Array<typeof roleSchema[number]>;
      const validation = validateSkill({ slug: params.slug, content: params.newContent, roles: roleList });
      if (!validation.valid) {
        return {
          content: [{ type: "text", text: `Evolution rejected by policy: ${validation.issues.map((issue) => issue.message).join("; ")}` }],
          details: { slug: params.slug, issues: validation.issues },
          isError: true,
        };
      }
      const row = await ctx.db.createSkillDraft({
        userId: ctx.userId,
        slug: params.slug,
        source: "evolution",
        originalContent: currentContent,
        candidateContent: params.newContent,
        selectedRoles: roleList,
        sessionId: ctx.sessionId,
      });
      return {
        content: [{
          type: "text",
          text:
            `Evolution draft for "${params.slug}" created.\n` +
            `Rationale: ${params.rationale}\n` +
            `The change is NOT applied yet. Tell the user to open /skills?draft=${row.id} to review the diff and confirm. ` +
            `After confirmation the live skill updates immediately (no server restart needed).`,
        }],
        details: { draftId: row.id, status: row.status, reviewUrl: `/skills?draft=${row.id}`, slug: params.slug },
      };
    },
  };
}
