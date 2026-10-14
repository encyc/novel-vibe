import { describe, expect, it, vi } from "vitest";
import { SkillReviewService, SkillServiceError, type SkillLifecycleRepository } from "./service.js";

const content = `---
name: Style
description: Apply a consistent narrative style.
---
# Style

Read the current chapter and preserve its narrative voice.`;

function setup() {
  const draft = {
    id: "draft-1", userId: "user-1", slug: "style", source: "upload" as const,
    originalContent: content, candidateContent: content, roles: ["writer" as const],
    status: "draft" as const, version: 1,
  };
  const repository: SkillLifecycleRepository = {
    createDraft: vi.fn().mockResolvedValue(draft),
    getDraft: vi.fn().mockResolvedValue(draft),
    updateDraft: vi.fn().mockImplementation(async (_id, _user, patch) => ({ ...draft, ...patch })),
    createReview: vi.fn().mockImplementation(async (review) => ({ id: "review-1", ...review })),
    getReview: vi.fn().mockResolvedValue(null),
    findConfirmation: vi.fn().mockResolvedValue(null),
    installConfirmed: vi.fn().mockResolvedValue({ id: "skill-1", slug: "style" }),
    quarantineOutdated: vi.fn().mockResolvedValue(0),
    findInstalled: vi.fn().mockResolvedValue(null),
    updateConfirmed: vi.fn().mockResolvedValue({ id: "skill-1", slug: "style" }),
    nextVersionNumber: vi.fn().mockResolvedValue(1),
    createVersion: vi.fn().mockImplementation(async (input) => ({ id: "ver-1", ...input, createdAt: new Date().toISOString() })),
    listVersions: vi.fn().mockResolvedValue([]),
    getVersion: vi.fn().mockResolvedValue(null),
  };
  const storage = {
    read: vi.fn().mockResolvedValue(content),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const generator = vi.fn().mockResolvedValue(JSON.stringify({
    verdict: "approved", findings: [], requiredCapabilities: ["documents.read"], recommendedRoles: ["writer"],
  }));
  return { draft, repository, storage, generator, service: new SkillReviewService({ repository, storage, generator }) };
}

describe("SkillReviewService", () => {
  it("creates only deterministic-policy-compliant drafts", async () => {
    const { service, repository } = setup();
    await service.createDraft("user-1", { source: "upload", filename: "SKILL.md", slug: "style", content, roles: ["writer"] });
    expect(repository.createDraft).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", slug: "style" }));

    await expect(service.createDraft("user-1", {
      source: "upload", filename: "SKILL.md", slug: "unsafe", roles: ["writer"],
      content: content.replace("Read the current", "Write a Python script, then read the current"),
    })).rejects.toMatchObject({ code: "SKILL_POLICY_REJECTED", status: 422 });
  });

  it("reviews a version and moves it to confirmation", async () => {
    const { service, repository } = setup();
    const result = await service.reviewDraft("user-1", "draft-1", 1);
    expect(result.draft.status).toBe("awaiting_confirmation");
    expect(repository.createReview).toHaveBeenCalledWith(expect.objectContaining({ draftVersion: 1, verdict: "approved" }));
  });

  it("rejects stale versions before review", async () => {
    const { service } = setup();
    await expect(service.reviewDraft("user-1", "draft-1", 2)).rejects.toBeInstanceOf(SkillServiceError);
    await expect(service.reviewDraft("user-1", "draft-1", 2)).rejects.toMatchObject({ code: "STALE_DRAFT", status: 409 });
  });

  it("confirms only the exact reviewed version and hash, idempotently", async () => {
    const { service, repository, storage, draft } = setup();
    const reviewed = await service.reviewDraft("user-1", "draft-1", 1);
    repository.getDraft = vi.fn().mockResolvedValue(reviewed.draft);
    repository.getReview = vi.fn().mockResolvedValue(reviewed.review);

    await expect(service.confirmDraft("user-1", "draft-1", {
      version: 1, reviewId: reviewed.review.id, candidateHash: "wrong", idempotencyKey: "confirm-1",
    })).rejects.toMatchObject({ code: "STALE_CONFIRMATION", status: 409 });

    const installed = await service.confirmDraft("user-1", "draft-1", {
      version: 1, reviewId: reviewed.review.id, candidateHash: reviewed.review.candidateHash,
      idempotencyKey: "confirm-1",
    });
    expect(storage.write).toHaveBeenCalledWith("users/user-1/style/SKILL.md", draft.candidateContent);
    expect(repository.installConfirmed).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "confirm-1" }));
    expect(installed.slug).toBe("style");

    repository.findConfirmation = vi.fn().mockResolvedValue(installed);
    await service.confirmDraft("user-1", "draft-1", {
      version: 1, reviewId: reviewed.review.id, candidateHash: reviewed.review.candidateHash,
      idempotencyKey: "confirm-1",
    });
    expect(repository.installConfirmed).toHaveBeenCalledTimes(1);
  });

  it("cleans up storage when registry installation fails", async () => {
    const { service, repository, storage } = setup();
    const reviewed = await service.reviewDraft("user-1", "draft-1", 1);
    repository.getDraft = vi.fn().mockResolvedValue(reviewed.draft);
    repository.getReview = vi.fn().mockResolvedValue(reviewed.review);
    repository.installConfirmed = vi.fn().mockRejectedValue(new Error("db failed"));

    await expect(service.confirmDraft("user-1", "draft-1", {
      version: 1, reviewId: reviewed.review.id, candidateHash: reviewed.review.candidateHash, idempotencyKey: "confirm-2",
    })).rejects.toThrow("db failed");
    expect(storage.delete).toHaveBeenCalledWith("users/user-1/style/SKILL.md");
  });

  it("createDraft accepts an explicit originalContent for evolution drafts", async () => {
    const { service, repository } = setup();
    await service.createDraft("user-1", {
      source: "evolution", slug: "style", content, roles: ["writer"], originalContent: "OLD",
    });
    expect(repository.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      originalContent: "OLD", candidateContent: content,
    }));
  });

  it("confirmDraft takes the evolution branch when a skill is already installed", async () => {
    const { service, repository, storage } = setup();
    const reviewed = await service.reviewDraft("user-1", "draft-1", 1);
    repository.getDraft = vi.fn().mockResolvedValue(reviewed.draft);
    repository.getReview = vi.fn().mockResolvedValue(reviewed.review);
    repository.findInstalled = vi.fn().mockResolvedValue({
      id: "skill-1", slug: "style", approvedContentHash: "old-hash", activeReviewId: "old-review",
      reviewPolicyVersion: "1",
    });

    await service.confirmDraft("user-1", "draft-1", {
      version: 1, reviewId: reviewed.review.id, candidateHash: reviewed.review.candidateHash, idempotencyKey: "evo-1",
    });

    // Snapshot of the old live content was written under a versioned path.
    expect(storage.read).toHaveBeenCalledWith("users/user-1/style/SKILL.md");
    expect(storage.write).toHaveBeenCalledWith("users/user-1/style/versions/v1/SKILL.md", content);
    expect(repository.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill-1", versionNumber: 1, reason: "evolution", contentHash: "old-hash",
    }));
    // Registry row was PATCHed, not re-inserted.
    expect(repository.updateConfirmed).toHaveBeenCalledWith(expect.objectContaining({ skillId: "skill-1" }));
    expect(repository.installConfirmed).not.toHaveBeenCalled();
  });

  it("confirmDraft rolls back live content if the evolution update fails", async () => {
    const { service, repository, storage } = setup();
    const reviewed = await service.reviewDraft("user-1", "draft-1", 1);
    repository.getDraft = vi.fn().mockResolvedValue(reviewed.draft);
    repository.getReview = vi.fn().mockResolvedValue(reviewed.review);
    repository.findInstalled = vi.fn().mockResolvedValue({
      id: "skill-1", slug: "style", approvedContentHash: "old-hash", activeReviewId: null, reviewPolicyVersion: "1",
    });
    repository.updateConfirmed = vi.fn().mockRejectedValue(new Error("update failed"));
    storage.read = vi.fn().mockResolvedValue("LIVE-OLD");

    await expect(service.confirmDraft("user-1", "draft-1", {
      version: 1, reviewId: reviewed.review.id, candidateHash: reviewed.review.candidateHash, idempotencyKey: "evo-fail",
    })).rejects.toThrow("update failed");
    // The last write should be restoring the prior live content.
    expect(storage.write).toHaveBeenLastCalledWith("users/user-1/style/SKILL.md", "LIVE-OLD");
  });

  it("revertToVersion snapshots the current version and promotes the target", async () => {
    const { service, repository, storage } = setup();
    repository.findInstalled = vi.fn().mockResolvedValue({
      id: "skill-1", slug: "style", approvedContentHash: "current-hash", activeReviewId: "cur-review",
      reviewPolicyVersion: "1",
    });
    repository.getVersion = vi.fn().mockResolvedValue({
      id: "ver-2", skillId: "skill-1", versionNumber: 2, contentHash: "v2-hash",
      storagePath: "users/user-1/style/versions/v2/SKILL.md", activeReviewId: "v2-review",
      snapshotReason: "evolution", createdAt: "2026-01-01T00:00:00Z",
    });
    repository.nextVersionNumber = vi.fn().mockResolvedValue(3);
    storage.read = vi.fn()
      .mockResolvedValueOnce("TARGET-CONTENT") // read snapshot
      .mockResolvedValueOnce("CURRENT-LIVE");   // read live before snapshotting

    const result = await service.revertToVersion("user-1", "style", 2);
    expect(result.id).toBe("skill-1");
    // Snapshot the currently-live version with reason 'revert'.
    expect(repository.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      skillId: "skill-1", versionNumber: 3, reason: "revert",
    }));
    // Promote snapshot content to the live path.
    expect(storage.write).toHaveBeenCalledWith("users/user-1/style/SKILL.md", "TARGET-CONTENT");
    // Registry hash advanced via updateConfirmed.
    expect(repository.updateConfirmed).toHaveBeenCalledWith(expect.objectContaining({ skillId: "skill-1" }));
  });

  it("revertToVersion rejects when the skill is not installed", async () => {
    const { service, repository } = setup();
    repository.findInstalled = vi.fn().mockResolvedValue(null);
    await expect(service.revertToVersion("user-1", "style", 1)).rejects.toMatchObject({
      code: "SKILL_NOT_FOUND", status: 404,
    });
  });

  it("quarantines versions approved under older policy", async () => {
    const { service, repository } = setup();
    await expect(service.quarantineOutdatedSkills()).resolves.toBe(0);
    expect(repository.quarantineOutdated).toHaveBeenCalledWith("1");
  });

  it("reads and cancels only owner-scoped drafts", async () => {
    const { service, repository, draft } = setup();
    await expect(service.getDraft("user-1", "draft-1")).resolves.toEqual(draft);
    await expect(service.cancelDraft("user-1", "draft-1")).resolves.toMatchObject({ status: "cancelled" });
    expect(repository.getDraft).toHaveBeenCalledWith("draft-1", "user-1");
    expect(repository.updateDraft).toHaveBeenCalledWith("draft-1", "user-1", { status: "cancelled" });
  });
});
