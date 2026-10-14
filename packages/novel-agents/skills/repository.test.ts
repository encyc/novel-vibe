import { describe, expect, it, vi } from "vitest";
import { SkillRepository } from "./repository.js";

describe("SkillRepository", () => {
  it("maps draft rows and keeps every query owner scoped", async () => {
    const db = {
      createSkillDraft: vi.fn().mockResolvedValue({
        id: "d1", user_id: "u1", slug: "style", source: "upload",
        original_content: "original", candidate_content: "candidate",
        selected_roles: ["writer"], status: "draft", version: 1, session_id: null,
      }),
      getSkillDraft: vi.fn().mockResolvedValue(null),
    } as any;
    const repository = new SkillRepository(db);
    const draft = await repository.createDraft({
      userId: "u1", slug: "style", source: "upload", originalContent: "original",
      candidateContent: "candidate", roles: ["writer"],
    });
    expect(draft).toMatchObject({ id: "d1", userId: "u1", roles: ["writer"] });

    await repository.getDraft("d1", "u1");
    expect(db.getSkillDraft).toHaveBeenCalledWith("d1", "u1");
  });

  it("installs exact reviewed metadata and roles", async () => {
    const db = {
      installReviewedSkill: vi.fn().mockResolvedValue({ id: "s1", slug: "style" }),
    } as any;
    const repository = new SkillRepository(db);
    await repository.installConfirmed({
      userId: "u1",
      idempotencyKey: "key-1",
      name: "Style",
      description: "Style guide",
      draft: {
        id: "d1", userId: "u1", slug: "style", source: "upload", originalContent: "a",
        candidateContent: "b", roles: ["writer"], status: "awaiting_confirmation", version: 1,
      },
      review: {
        id: "r1", draftId: "d1", draftVersion: 1, verdict: "approved", findings: [],
        requiredCapabilities: ["documents.read"], recommendedRoles: ["writer"],
        originalHash: "old", candidateHash: "new", policyVersion: "1",
      },
    });
    expect(db.installReviewedSkill).toHaveBeenCalledWith(expect.objectContaining({
      activeReviewId: "r1", approvedContentHash: "new", roles: ["writer"],
      requiredCapabilities: ["documents.read"], confirmationKey: "key-1",
    }));
  });

  it("finds an installed skill and maps registry columns", async () => {
    const db = {
      findInstalledSkillBySlug: vi.fn().mockResolvedValue({
        id: "s1", slug: "style", approved_content_hash: "hash-1",
        active_review_id: "r1", review_policy_version: "1",
      }),
    } as any;
    const repository = new SkillRepository(db);
    const installed = await repository.findInstalled("u1", "style");
    expect(installed).toMatchObject({
      id: "s1", approvedContentHash: "hash-1", activeReviewId: "r1", reviewPolicyVersion: "1",
    });
  });

  it("updates an installed skill via the PATCH db method", async () => {
    const db = { updateInstalledSkill: vi.fn().mockResolvedValue({ id: "s1", slug: "style" }) } as any;
    const repository = new SkillRepository(db);
    await repository.updateConfirmed({
      userId: "u1", skillId: "s1", name: "Style", description: "guide", idempotencyKey: "k1",
      draft: { slug: "style", roles: ["writer"] } as any,
      review: { id: "r1", candidateHash: "new", policyVersion: "1" } as any,
    });
    expect(db.updateInstalledSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "s1", approvedContentHash: "new", roles: ["writer"], confirmationKey: "k1",
    }));
  });

  it("creates and maps a version snapshot", async () => {
    const db = {
      createSkillVersion: vi.fn().mockResolvedValue({
        id: "v1", skill_id: "s1", version_number: 1, content_hash: "h1",
        storage_path: "users/u1/style/versions/v1/SKILL.md", active_review_id: "r1",
        snapshot_reason: "evolution", created_at: "2026-01-01T00:00:00Z",
      }),
    } as any;
    const repository = new SkillRepository(db);
    const version = await repository.createVersion({
      skillId: "s1", versionNumber: 1, contentHash: "h1",
      storagePath: "users/u1/style/versions/v1/SKILL.md", reason: "evolution",
    });
    expect(version).toMatchObject({ versionNumber: 1, snapshotReason: "evolution" });
    expect(db.createSkillVersion).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "s1", versionNumber: 1, snapshotReason: "evolution",
    }));
  });

  it("lists version summaries in descending order", async () => {
    const db = {
      listSkillVersions: vi.fn().mockResolvedValue([
        { version_number: 2, snapshot_reason: "evolution", created_at: "2026-02-01", content_hash: "h2" },
        { version_number: 1, snapshot_reason: "install", created_at: "2026-01-01", content_hash: "h1" },
      ]),
    } as any;
    const repository = new SkillRepository(db);
    const versions = await repository.listVersions("u1", "style");
    expect(db.listSkillVersions).toHaveBeenCalledWith("u1", "style");
    expect(versions).toEqual([
      { versionNumber: 2, snapshotReason: "evolution", createdAt: "2026-02-01", contentHash: "h2" },
      { versionNumber: 1, snapshotReason: "install", createdAt: "2026-01-01", contentHash: "h1" },
    ]);
  });

  it("returns empty when listing versions for a skill that is not installed", async () => {
    const db = { listSkillVersions: vi.fn().mockResolvedValue([]) } as any;
    const repository = new SkillRepository(db);
    const versions = await repository.listVersions("u1", "missing");
    expect(versions).toEqual([]);
  });
});
