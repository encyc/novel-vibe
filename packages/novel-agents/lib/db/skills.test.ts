import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("listSkillRegistry", () => {
    it("returns skills ordered by name", async () => {
      ctx.mockOk([{ slug: "test-skill", name: "Test Skill" }]);
      const skills = await ctx.db.listSkillRegistry();
      expect(skills).toHaveLength(1);
      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("order=name.asc");
    });
  });

describe("getSkillFromRegistry", () => {
    it("returns skill when found", async () => {
      ctx.mockOk([{ slug: "test-skill", name: "Test" }]);
      const skill = await ctx.db.getSkillFromRegistry("test-skill");
      expect(skill).toEqual({ slug: "test-skill", name: "Test" });
    });

    it("returns null when not found", async () => {
      ctx.mockOk([]);
      const skill = await ctx.db.getSkillFromRegistry("nonexistent");
      expect(skill).toBeNull();
    });
  });

describe("installSkill", () => {
    it("sends POST with skill fields", async () => {
      ctx.mockOk([{ slug: "new-skill", name: "New" }]);
      await ctx.db.installSkill({
        slug: "new-skill",
        name: "New Skill",
        description: "desc",
        storagePath: "skills/new-skill/",
        version: "1.0.0",
      });

      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.slug).toBe("new-skill");
      expect(body.name).toBe("New Skill");
      expect(body.storage_path).toBe("skills/new-skill/");
    });
  });

describe("reviewed skill lifecycle", () => {
    it("creates owner-scoped drafts in the public schema", async () => {
      ctx.mockOk([{ id: "d1", user_id: "u1" }]);
      await ctx.db.createSkillDraft({
        userId: "u1", slug: "style", source: "upload", originalContent: "a",
        candidateContent: "a", selectedRoles: ["writer"],
      });
      const [, init] = ctx.fetchMock.mock.calls[0];
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Profile"]).toBe("public");
      expect(JSON.parse(init.body)).toMatchObject({ user_id: "u1", selected_roles: ["writer"] });
    });

    it("installs approval metadata and role rows", async () => {
      ctx.mockOk([{ id: "s1", slug: "style" }]);
      ctx.mockOk([]);
      await ctx.db.installReviewedSkill({
        slug: "style", name: "Style", description: "Guide", storagePath: "users/u1/style",
        userId: "u1", activeReviewId: "r1", approvedContentHash: "hash",
        reviewPolicyVersion: "1", requiredCapabilities: ["documents.read"],
        roles: ["writer"], confirmationKey: "key-1",
      });
      const registryBody = JSON.parse(ctx.fetchMock.mock.calls[0][1].body);
      const roleBody = JSON.parse(ctx.fetchMock.mock.calls[1][1].body);
      expect(registryBody).toMatchObject({ active_review_id: "r1", approved_content_hash: "hash", confirmation_key: "key-1" });
      expect(roleBody).toEqual([{ skill_id: "s1", role: "writer" }]);
    });
  });

describe("uninstallSkill", () => {
    it("sends DELETE request", async () => {
      ctx.mockOk();
      await ctx.db.uninstallSkill("old-skill");
      expect(ctx.fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    });

    it("appends user_id filter when userId provided", async () => {
      ctx.mockOk();
      await ctx.db.uninstallSkill("old-skill", "user-5");
      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("user_id=eq.user-5");
    });
  });

describe("getSkillRegistrySource", () => {
    it("returns source when skill is found", async () => {
      ctx.mockOk([{ source: "built-in" }]);
      const source = await ctx.db.getSkillRegistrySource("my-skill");
      expect(source).toBe("built-in");
    });

    it("returns null when skill not found", async () => {
      ctx.mockOk([]);
      const source = await ctx.db.getSkillRegistrySource("missing");
      expect(source).toBeNull();
    });

    it("returns null on HTTP error", async () => {
      ctx.mockError();
      const source = await ctx.db.getSkillRegistrySource("error-skill");
      expect(source).toBeNull();
    });
  });

describe("listWorkspaceSkills", () => {
    it("returns skills for a workspace ordered by created_at", async () => {
      ctx.mockOk([{ id: 1, skill_slug: "test", enabled: true }]);
      const skills = await ctx.db.listWorkspaceSkills("ws-1");
      expect(skills).toHaveLength(1);
      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("workspace_id=eq.ws-1");
      expect(url).toContain("order=created_at.asc");
    });
  });

describe("getWorkspaceSkill", () => {
    it("returns skill when found", async () => {
      ctx.mockOk([{ skill_slug: "test", enabled: true }]);
      const skill = await ctx.db.getWorkspaceSkill("ws-1", "test");
      expect(skill).toEqual({ skill_slug: "test", enabled: true });
    });

    it("returns null when not found", async () => {
      ctx.mockOk([]);
      const skill = await ctx.db.getWorkspaceSkill("ws-1", "nonexistent");
      expect(skill).toBeNull();
    });
  });

describe("toggleWorkspaceSkill", () => {
    it("PATCHes existing workspace skill", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ skill_slug: "test", enabled: false }]),
      });
      ctx.mockOk();

      await ctx.db.toggleWorkspaceSkill("ws-1", "test", true);

      // Second call should be PATCH
      const [, opts] = ctx.fetchMock.mock.calls[1];
      expect(opts.method).toBe("PATCH");
      expect(JSON.parse(opts.body as string)).toEqual({ enabled: true });
    });

    it("INSERTs new workspace skill when not existing", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      ctx.mockOk([{ skill_slug: "test", enabled: true }]);

      await ctx.db.toggleWorkspaceSkill("ws-1", "test", true);

      // Second call should be POST
      const [, opts] = ctx.fetchMock.mock.calls[1];
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body as string);
      expect(body.workspace_id).toBe("ws-1");
      expect(body.skill_slug).toBe("test");
      expect(body.enabled).toBe(true);
    });
  });
