import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const { mockResourceLoad } = vi.hoisted(() => ({ mockResourceLoad: vi.fn() }));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

// ── Mock DbClient and StorageClient ──────────────────────────────
const mockDbInstance = {
  listSkillRegistry: vi.fn(),
  getSkillFromRegistry: vi.fn(),
  getSkillForUser: vi.fn(),
  installSkill: vi.fn(),
  uninstallSkill: vi.fn(),
  listWorkspaceSkills: vi.fn(),
  toggleWorkspaceSkill: vi.fn(),
  getWorkspaceSkill: vi.fn(),
  getSkillRegistrySource: vi.fn(),
  listSkillRoles: vi.fn(),
  upsertDocumentIndex: vi.fn(),
};

const mockStorageInstance = {
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
};

vi.mock("./db.js", () => ({
  DbClient: {
    forUser: vi.fn().mockImplementation(() => mockDbInstance),
    forSystem: vi.fn().mockImplementation(() => mockDbInstance),
  },
}));

vi.mock("./storage.js", () => ({
  StorageClient: {
    forUser: vi.fn().mockImplementation(() => mockStorageInstance),
    forSystem: vi.fn().mockImplementation(() => mockStorageInstance),
  },
}));

vi.mock("./agent-resources/runtime.js", () => ({
  getAgentResourceService: () => ({ load: mockResourceLoad }),
}));

import {
  listInstalledSkills,
  getSkillFromRegistry,
  uninstallSkill,
  getWorkspaceSkills,
  toggleWorkspaceSkill,
  loadEnabledSkills,
  loadSkillsForUI,
  loadSkillForUI,
  listSkillFiles,
  enableDefaultSkillsForWorkspace,
  listAllSkillsForUI,
} from "./skills.js";

describe("skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-secret-32-chars-minimum!!";
    process.env.INSFORGE_URL = "http://localhost:7130";
    mockDbInstance.listSkillRoles.mockResolvedValue(["chief_editor"]);
    mockResourceLoad.mockImplementation(async (input: { fallback?: () => string | null }) => ({
      content: input.fallback?.() ?? "",
      source: "fallback",
    }));
  });

  const mockRegistryEntry = (slug: string, name?: string, source = "user", userId?: string) => ({
    id: `id-${slug}`,
    slug,
    name: name ?? slug,
    description: "A test skill",
    storage_path: source === "built-in" ? `builtin/${slug}` : `users/${userId ?? "u-default"}/${slug}`,
    version: "1.0.0",
    source,
    user_id: source === "built-in" ? null : (userId ?? "u-default"),
    created_at: "2024-01-01T00:00:00Z",
    review_status: source === "built-in" ? null : "approved",
    review_policy_version: source === "built-in" ? null : "1",
    approved_content_hash: null,
    metadata: source === "built-in" ? null : { requiredCapabilities: [] },
  });

  // ── Existing: registry CRUD ────────────────────────────────────

  describe("listInstalledSkills", () => {
    it("returns skills from registry", async () => {
      mockDbInstance.listSkillRegistry.mockResolvedValue([
        mockRegistryEntry("skill-a"),
        mockRegistryEntry("skill-b"),
      ]);
      const skills = await listInstalledSkills("token");
      expect(skills).toHaveLength(2);
    });
  });

  describe("getSkillFromRegistry", () => {
    it("returns skill when found", async () => {
      const entry = mockRegistryEntry("test-skill");
      mockDbInstance.getSkillFromRegistry.mockResolvedValue(entry);
      const skill = await getSkillFromRegistry("test-skill", "token");
      expect(skill).toEqual(entry);
    });

    it("returns null when not found", async () => {
      mockDbInstance.getSkillFromRegistry.mockResolvedValue(null);
      const skill = await getSkillFromRegistry("nonexistent", "token");
      expect(skill).toBeNull();
    });
  });

  // ── Existing: uninstall ─────────────────────────────────────────

  describe("uninstallSkill", () => {
    it("deletes from storage and registry", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("old-skill", undefined, "user", "u-1"));
      mockDbInstance.uninstallSkill.mockResolvedValue(undefined);
      await uninstallSkill("token", "old-skill", "u-1");

      expect(mockStorageInstance.delete).toHaveBeenCalledWith("users/u-1/old-skill/SKILL.md");
      expect(mockDbInstance.uninstallSkill).toHaveBeenCalledWith("old-skill", "u-1");
    });

    it("handles storage delete failure gracefully", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("old-skill", undefined, "user", "u-1"));
      mockStorageInstance.delete.mockRejectedValue(new Error("not found"));
      mockDbInstance.uninstallSkill.mockResolvedValue(undefined);
      await expect(uninstallSkill("token", "old-skill", "u-1")).resolves.toBeUndefined();
    });

    it("requires userId", async () => {
      await expect(uninstallSkill("token", "old-skill")).rejects.toThrow("userId is required");
    });

    it("refuses to uninstall built-in skills", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("skill-creator", undefined, "built-in"));
      await expect(uninstallSkill("token", "skill-creator", "u-1")).rejects.toThrow("Cannot uninstall built-in");
    });
  });

  // ── Existing: workspace skills ──────────────────────────────────

  describe("getWorkspaceSkills", () => {
    it("merges registry with workspace toggle state", async () => {
      mockDbInstance.listSkillRegistry.mockResolvedValue([
        mockRegistryEntry("skill-a"),
        mockRegistryEntry("skill-b"),
      ]);
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([
        { skill_slug: "skill-a", enabled: true },
        { skill_slug: "skill-b", enabled: false },
      ]);

      const skills = await getWorkspaceSkills("token", "ws-1");
      expect(skills).toHaveLength(2);
      expect(skills[0].enabled).toBe(true);
      expect(skills[1].enabled).toBe(false);
    });

    it("defaults to disabled for unset skills", async () => {
      mockDbInstance.listSkillRegistry.mockResolvedValue([mockRegistryEntry("new-skill")]);
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([]);

      const skills = await getWorkspaceSkills("token", "ws-1");
      expect(skills[0].enabled).toBe(false);
    });

    it("hides unapproved and quarantined user Skills", async () => {
      mockDbInstance.listSkillRegistry.mockResolvedValue([
        { ...mockRegistryEntry("good"), review_status: "approved" },
        { ...mockRegistryEntry("pending"), review_status: "review_required" },
        { ...mockRegistryEntry("unsafe"), review_status: "quarantined" },
      ]);
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([]);
      expect((await getWorkspaceSkills("token", "ws-1", "u-1")).map((skill) => skill.slug)).toEqual(["good"]);
    });
  });

  describe("toggleWorkspaceSkill", () => {
    it("verifies skill exists before toggling", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(null);
      await expect(toggleWorkspaceSkill("token", "ws-1", "bad", true, "u-1")).rejects.toThrow(
        "Skill not found",
      );
    });

    it("toggles when skill exists", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("valid", undefined, "user", "u-1"));
      mockDbInstance.toggleWorkspaceSkill.mockResolvedValue(undefined);
      await toggleWorkspaceSkill("token", "ws-1", "valid", true, "u-1");
      expect(mockDbInstance.toggleWorkspaceSkill).toHaveBeenCalledWith("ws-1", "valid", true);
    });

    it("refuses to enable an unapproved user Skill", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue({ ...mockRegistryEntry("unsafe"), review_status: "quarantined" });
      await expect(toggleWorkspaceSkill("token", "ws-1", "unsafe", true, "u-1")).rejects.toThrow("not approved");
    });
  });

  // ── Existing: load skills ───────────────────────────────────────

  describe("loadEnabledSkills", () => {
    it("filters enabled skills and loads SKILL.md for each", async () => {
      const content = `---
name: Skill A
description: A skill
---
# Skill A Body`;
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([
        { skill_slug: "skill-a", enabled: true },
        { skill_slug: "skill-b", enabled: false },
      ]);
      mockDbInstance.getSkillForUser.mockResolvedValue({
        ...mockRegistryEntry("skill-a", undefined, "user", "u-1"),
        approved_content_hash: createHash("sha256").update(content).digest("hex"),
      });
      mockStorageInstance.read.mockResolvedValue(content);

      const skills = await loadEnabledSkills("token", "ws-1", "u-1");
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("Skill A");
      expect(skills[0].description).toBe("A skill");
      // user skill read from namespaced path
      expect(mockStorageInstance.read).toHaveBeenCalledWith("users/u-1/skill-a/SKILL.md");
    });

    it("loads built-in skills through the platform resource service", async () => {
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([
        { skill_slug: "skill-creator", enabled: true },
      ]);
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("skill-creator", undefined, "built-in"));
      const fsMod = await import("node:fs");
      vi.mocked(fsMod.default.readFileSync).mockReturnValue(`---
name: Skill Creator
description: creates skills
---
# body`);

      const skills = await loadEnabledSkills("token", "ws-1", "u-1");
      expect(skills).toHaveLength(1);
      expect(mockResourceLoad).toHaveBeenCalledWith(expect.objectContaining({
        type: "builtin_skill", key: "skill-creator",
      }));
      // Built-ins never use per-user Storage credentials.
      expect(mockStorageInstance.read).not.toHaveBeenCalled();
    });

    it("handles missing registry entry gracefully", async () => {
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([
        { skill_slug: "missing", enabled: true },
      ]);
      mockDbInstance.getSkillForUser.mockResolvedValue(null);

      const skills = await loadEnabledSkills("token", "ws-1", "u-1");
      expect(skills).toHaveLength(0);
    });

    it("handles storage read failure gracefully", async () => {
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([
        { skill_slug: "broken", enabled: true },
      ]);
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("broken", undefined, "user", "u-1"));
      mockStorageInstance.read.mockRejectedValue(new Error("storage error"));

      const skills = await loadEnabledSkills("token", "ws-1", "u-1");
      expect(skills).toHaveLength(0);
    });

    it.each(["review_required", "quarantined"])("does not load %s user skills", async (reviewStatus) => {
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([{ skill_slug: "skill-a", enabled: true }]);
      mockDbInstance.getSkillForUser.mockResolvedValue({ ...mockRegistryEntry("skill-a", undefined, "user", "u-1"), review_status: reviewStatus });
      mockStorageInstance.read.mockResolvedValue("---\nname: A\ndescription: A\n---\nbody");
      expect(await loadEnabledSkills("token", "ws-1", "u-1", "chief_editor")).toEqual([]);
    });

    it("enforces target role, capability compatibility, policy, and content hash", async () => {
      const content = "---\nname: A\ndescription: A\n---\nbody";
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([{ skill_slug: "skill-a", enabled: true }]);
      const base = mockRegistryEntry("skill-a", undefined, "user", "u-1");
      mockStorageInstance.read.mockResolvedValue(content);

      mockDbInstance.getSkillForUser.mockResolvedValue({ ...base, review_policy_version: "old" });
      expect(await loadEnabledSkills("token", "ws-1", "u-1", "writer")).toEqual([]);

      mockDbInstance.getSkillForUser.mockResolvedValue(base);
      mockDbInstance.listSkillRoles.mockResolvedValue(["director"]);
      expect(await loadEnabledSkills("token", "ws-1", "u-1", "writer")).toEqual([]);

      mockDbInstance.listSkillRoles.mockResolvedValue(["writer"]);
      mockDbInstance.getSkillForUser.mockResolvedValue({ ...base, metadata: { requiredCapabilities: ["agents.delegate"] } });
      expect(await loadEnabledSkills("token", "ws-1", "u-1", "writer")).toEqual([]);

      mockDbInstance.getSkillForUser.mockResolvedValue({ ...base, approved_content_hash: "wrong" });
      expect(await loadEnabledSkills("token", "ws-1", "u-1", "writer")).toEqual([]);
    });
  });

  // ── Existing: UI loaders ────────────────────────────────────────

  describe("loadSkillsForUI", () => {
    it("returns only enabled skills as LoadedSkill[]", async () => {
      mockDbInstance.listSkillRegistry.mockResolvedValue([
        mockRegistryEntry("skill-a", "Skill A", "user"),
        mockRegistryEntry("skill-b", "Skill B", "user"),
      ]);
      mockDbInstance.listWorkspaceSkills.mockResolvedValue([
        { skill_slug: "skill-a", enabled: true },
        { skill_slug: "skill-b", enabled: false },
      ]);

      const result = await loadSkillsForUI("token", "ws-1");
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe("skill-a");
      expect(result[0].source).toBe("user");
    });
  });

  describe("loadSkillForUI", () => {
    it("returns single skill with full content", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("test", undefined, "user", "u-1"));
      mockStorageInstance.read.mockResolvedValue(`---
name: Test
description: Desc
---
# Body content`);

      const result = await loadSkillForUI("token", "test", "u-1");
      expect(result).not.toBeNull();
      expect(result!.metadata.name).toBe("Test");
      expect(result!.content).toBe("# Body content");
      expect(mockStorageInstance.read).toHaveBeenCalledWith("users/u-1/test/SKILL.md");
    });

    it("returns null when registry entry missing", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(null);
      const result = await loadSkillForUI("token", "nonexistent", "u-1");
      expect(result).toBeNull();
    });

    it("returns null when storage read fails", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("test", undefined, "user", "u-1"));
      mockStorageInstance.read.mockRejectedValue(new Error("fail"));
      const result = await loadSkillForUI("token", "test", "u-1");
      expect(result).toBeNull();
    });
  });

  describe("listSkillFiles", () => {
    it("returns SKILL.md entry with byte size", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("test", undefined, "user", "u-1"));
      mockStorageInstance.read.mockResolvedValue("# Hello");

      const files = await listSkillFiles("token", "test", "u-1");
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe("SKILL.md");
      expect(files[0].type).toBe("file");
      expect(files[0].size).toBeGreaterThan(0);
    });

    it("returns empty when skill not found", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(null);
      const files = await listSkillFiles("token", "nonexistent", "u-1");
      expect(files).toEqual([]);
    });

    it("returns empty when storage read fails", async () => {
      mockDbInstance.getSkillForUser.mockResolvedValue(mockRegistryEntry("test", undefined, "user", "u-1"));
      mockStorageInstance.read.mockRejectedValue(new Error("fail"));
      const files = await listSkillFiles("token", "test", "u-1");
      expect(files).toEqual([]);
    });
  });

  describe("enableDefaultSkillsForWorkspace", () => {
    it("enables each slug that exists in registry", async () => {
      mockDbInstance.getSkillFromRegistry
        .mockResolvedValueOnce(mockRegistryEntry("skill-a"))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockRegistryEntry("skill-c"));
      mockDbInstance.toggleWorkspaceSkill.mockResolvedValue(undefined);

      await enableDefaultSkillsForWorkspace("token", "ws-1", ["skill-a", "skill-b", "skill-c"]);

      expect(mockDbInstance.toggleWorkspaceSkill).toHaveBeenCalledTimes(2);
      expect(mockDbInstance.toggleWorkspaceSkill).toHaveBeenCalledWith("ws-1", "skill-a", true);
      expect(mockDbInstance.toggleWorkspaceSkill).toHaveBeenCalledWith("ws-1", "skill-c", true);
    });
  });

  describe("listAllSkillsForUI", () => {
    it("returns all skills from registry as LoadedSkill[]", async () => {
      mockDbInstance.listSkillRegistry.mockResolvedValue([
        mockRegistryEntry("skill-a", "Skill A"),
        mockRegistryEntry("skill-b", "Skill B"),
      ]);
      const result = await listAllSkillsForUI("token");
      expect(result).toHaveLength(2);
      expect(result[0].slug).toBe("skill-a");
      expect(result[1].slug).toBe("skill-b");
    });
  });
});
