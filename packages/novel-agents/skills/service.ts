import crypto from "node:crypto";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { SKILL_POLICY_VERSION, type SkillRole, validateSkill } from "./policy.js";
import { reviewSkill, type ReviewGenerator, type SemanticFinding } from "./reviewer.js";

export type SkillDraftStatus = "draft" | "reviewing" | "revision_required" | "awaiting_confirmation" | "rejected" | "cancelled" | "installed";

export interface SkillDraft {
  id: string;
  userId: string;
  slug: string;
  source: "upload" | "paste" | "skill_creator";
  originalContent: string;
  candidateContent: string;
  roles: SkillRole[];
  status: SkillDraftStatus;
  version: number;
  sessionId?: string;
}

export interface SkillReview {
  id: string;
  draftId: string;
  draftVersion: number;
  verdict: "approved" | "revision_required" | "rejected" | "failed";
  findings: SemanticFinding[];
  requiredCapabilities: string[];
  recommendedRoles: SkillRole[];
  originalHash: string;
  candidateHash: string;
  policyVersion: string;
}

export interface InstalledSkillResult { id: string; slug: string; [key: string]: unknown }

export interface InstalledSkill {
  id: string;
  slug: string;
  approvedContentHash: string | null;
  activeReviewId: string | null;
  reviewPolicyVersion: string | null;
}

export interface SkillVersionSnapshot {
  id: string;
  skillId: string;
  versionNumber: number;
  contentHash: string;
  storagePath: string;
  activeReviewId: string | null;
  snapshotReason: "evolution" | "revert" | "install";
  createdAt: string;
}

export interface SkillVersionSummary {
  versionNumber: number;
  snapshotReason: string;
  createdAt: string;
  contentHash: string;
}

export interface SkillLifecycleRepository {
  createDraft(input: Omit<SkillDraft, "id" | "status" | "version">): Promise<SkillDraft>;
  getDraft(id: string, userId: string): Promise<SkillDraft | null>;
  updateDraft(id: string, userId: string, patch: Partial<Pick<SkillDraft, "candidateContent" | "status" | "version">>): Promise<SkillDraft>;
  createReview(input: Omit<SkillReview, "id">): Promise<SkillReview>;
  getReview(id: string, draftId: string): Promise<SkillReview | null>;
  findConfirmation(userId: string, idempotencyKey: string): Promise<InstalledSkillResult | null>;
  installConfirmed(input: {
    userId: string; draft: SkillDraft; review: SkillReview; idempotencyKey: string;
    name: string; description: string;
  }): Promise<InstalledSkillResult>;
  quarantineOutdated(activePolicyVersion: string): Promise<number>;
  /** Find an already-installed USER skill by (slug, userId), or null if none. */
  findInstalled(userId: string, slug: string): Promise<InstalledSkill | null>;
  /** Update an existing installed skill in place (evolution / revert path). */
  updateConfirmed(input: {
    userId: string; skillId: string; draft: SkillDraft; review: SkillReview;
    idempotencyKey: string; name: string; description: string;
  }): Promise<InstalledSkillResult>;
  /** Next monotonic version number for a skill (max + 1, or 1). */
  nextVersionNumber(skillId: string): Promise<number>;
  /** Persist a snapshot of a prior skill version. */
  createVersion(input: {
    skillId: string; versionNumber: number; contentHash: string;
    storagePath: string; activeReviewId?: string | null; reason: SkillVersionSnapshot["snapshotReason"];
  }): Promise<SkillVersionSnapshot>;
  /** List version history summaries for a user skill. */
  listVersions(userId: string, slug: string): Promise<SkillVersionSummary[]>;
  /** Get a specific version snapshot (for revert lookups). */
  getVersion(skillId: string, versionNumber: number): Promise<SkillVersionSnapshot | null>;
}

interface SkillStorage {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<unknown>;
  delete(path: string): Promise<unknown>;
}

export class SkillServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "SkillServiceError";
  }
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export class SkillReviewService {
  constructor(private readonly deps: {
    repository: SkillLifecycleRepository;
    storage: SkillStorage;
    generator: ReviewGenerator;
  }) {}

  async createDraft(userId: string, input: {
    source: SkillDraft["source"];
    filename?: string;
    slug: string;
    content: string;
    roles: string[];
    sessionId?: string;
    /**
     * Original content for evolution drafts: the currently-installed version, so
     * the front-end diff view shows the change from the live skill. When omitted
     * (new-skill drafts) it defaults to `content`.
     */
    originalContent?: string;
  }): Promise<SkillDraft> {
    const validation = validateSkill(input);
    if (!validation.valid) {
      throw new SkillServiceError("SKILL_POLICY_REJECTED", "SKILL.md violates the upload policy", 422);
    }
    const originalContent = input.originalContent ?? input.content;
    return this.deps.repository.createDraft({
      userId,
      slug: input.slug,
      source: input.source,
      originalContent,
      candidateContent: input.content,
      roles: input.roles as SkillRole[],
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  }

  async getDraft(userId: string, draftId: string): Promise<SkillDraft> {
    const draft = await this.deps.repository.getDraft(draftId, userId);
    if (!draft) throw new SkillServiceError("SKILL_DRAFT_NOT_FOUND", "Skill draft not found", 404);
    return draft;
  }

  async cancelDraft(userId: string, draftId: string): Promise<SkillDraft> {
    await this.getDraft(userId, draftId);
    return this.deps.repository.updateDraft(draftId, userId, { status: "cancelled" });
  }

  async reviewDraft(userId: string, draftId: string, expectedVersion: number): Promise<{ draft: SkillDraft; review: SkillReview }> {
    const draft = await this.deps.repository.getDraft(draftId, userId);
    if (!draft) throw new SkillServiceError("SKILL_DRAFT_NOT_FOUND", "Skill draft not found", 404);
    if (draft.version !== expectedVersion) throw new SkillServiceError("STALE_DRAFT", "Skill draft version changed", 409);

    const validation = validateSkill({ slug: draft.slug, content: draft.candidateContent, roles: draft.roles });
    if (!validation.valid) throw new SkillServiceError("SKILL_POLICY_REJECTED", "SKILL.md violates the upload policy", 422);
    await this.deps.repository.updateDraft(draft.id, userId, { status: "reviewing" });
    const result = await reviewSkill({
      slug: draft.slug,
      content: draft.candidateContent,
      roles: draft.roles,
      deterministicIssues: validation.issues,
    }, this.deps.generator);
    const review = await this.deps.repository.createReview({
      draftId: draft.id,
      draftVersion: draft.version,
      verdict: result.verdict,
      findings: result.findings,
      requiredCapabilities: result.requiredCapabilities,
      recommendedRoles: result.recommendedRoles,
      originalHash: sha256(draft.originalContent),
      candidateHash: sha256(result.candidateContent),
      policyVersion: SKILL_POLICY_VERSION,
    });
    const status: SkillDraftStatus = result.verdict === "approved" || result.verdict === "revision_required"
      ? "awaiting_confirmation"
      : result.verdict === "rejected" ? "rejected" : "revision_required";
    const updated = await this.deps.repository.updateDraft(draft.id, userId, {
      candidateContent: result.candidateContent,
      status,
    });
    return { draft: updated, review };
  }

  async confirmDraft(userId: string, draftId: string, input: {
    version: number;
    reviewId: string;
    candidateHash: string;
    idempotencyKey: string;
  }): Promise<InstalledSkillResult> {
    const existing = await this.deps.repository.findConfirmation(userId, input.idempotencyKey);
    if (existing) return existing;
    const draft = await this.deps.repository.getDraft(draftId, userId);
    const review = await this.deps.repository.getReview(input.reviewId, draftId);
    if (!draft || !review) throw new SkillServiceError("SKILL_REVIEW_NOT_FOUND", "Reviewed draft not found", 404);
    if (draft.status !== "awaiting_confirmation" || draft.version !== input.version
      || review.draftVersion !== input.version || review.candidateHash !== input.candidateHash
      || sha256(draft.candidateContent) !== input.candidateHash
      || (review.verdict !== "approved" && review.verdict !== "revision_required")) {
      throw new SkillServiceError("STALE_CONFIRMATION", "The reviewed Skill changed before confirmation", 409);
    }
    const frontmatter = parseFrontmatter(draft.candidateContent).frontmatter;
    const name = String(frontmatter.name ?? "");
    const description = String(frontmatter.description ?? "");
    const path = `users/${userId}/${draft.slug}/SKILL.md`;

    // Evolution branch: an installed skill already exists for this (slug, user),
    // so snapshot the live version, then PATCH the registry in place instead of
    // POST (which would collide on idx_skill_registry_slug_source_user).
    const installed = await this.deps.repository.findInstalled(userId, draft.slug);
    if (installed) {
      let currentContent = "";
      try {
        currentContent = await this.deps.storage.read(path);
      } catch {
        // Live object missing (shouldn't happen for an approved skill). Snapshot
        // an empty marker so the version row still records the transition.
      }
      const versionNum = await this.deps.repository.nextVersionNumber(installed.id);
      const snapshotPath = `users/${userId}/${draft.slug}/versions/v${versionNum}/SKILL.md`;
      await this.deps.storage.write(snapshotPath, currentContent);
      await this.deps.repository.createVersion({
        skillId: installed.id,
        versionNumber: versionNum,
        contentHash: installed.approvedContentHash ?? sha256(currentContent),
        storagePath: snapshotPath,
        activeReviewId: installed.activeReviewId,
        reason: "evolution",
      });
      await this.deps.storage.write(path, draft.candidateContent);
      try {
        const updated = await this.deps.repository.updateConfirmed({
          userId, skillId: installed.id, draft, review,
          idempotencyKey: input.idempotencyKey, name, description,
        });
        await this.deps.repository.updateDraft(draft.id, userId, { status: "installed" });
        return updated;
      } catch (error) {
        // Best-effort: roll back the live content so the skill stays loadable.
        try { await this.deps.storage.write(path, currentContent); } catch { /* best-effort */ }
        throw error;
      }
    }

    // Fresh-install branch (unchanged): POST a new registry row.
    await this.deps.storage.write(path, draft.candidateContent);
    try {
      const installedResult = await this.deps.repository.installConfirmed({
        userId, draft, review, idempotencyKey: input.idempotencyKey, name, description,
      });
      await this.deps.repository.updateDraft(draft.id, userId, { status: "installed" });
      return installedResult;
    } catch (error) {
      try { await this.deps.storage.delete(path); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }

  /**
   * Revert an installed skill to a prior snapshot. The snapshot content is
   * written back as the live version, the registry hash is advanced to match,
   * and the currently-active version is itself snapshotted so the revert is
   * reversible. This bypasses LLM review (the target is a previously-reviewed
   * version); human-in-the-loop is the user clicking "revert" in the UI.
   */
  async revertToVersion(userId: string, slug: string, versionNumber: number): Promise<InstalledSkill> {
    const installed = await this.deps.repository.findInstalled(userId, slug);
    if (!installed) throw new SkillServiceError("SKILL_NOT_FOUND", "Installed skill not found", 404);
    const target = await this.deps.repository.getVersion(installed.id, versionNumber);
    if (!target) throw new SkillServiceError("SKILL_VERSION_NOT_FOUND", "Skill version not found", 404);

    const path = `users/${userId}/${slug}/SKILL.md`;
    const snapshotContent = await this.deps.storage.read(target.storagePath);
    const candidateHash = sha256(snapshotContent);

    // Snapshot the current live version first so the revert is itself reversible.
    let currentContent = "";
    try { currentContent = await this.deps.storage.read(path); } catch { /* missing live */ }
    const versionNum = await this.deps.repository.nextVersionNumber(installed.id);
    const snapshotPath = `users/${userId}/${slug}/versions/v${versionNum}/SKILL.md`;
    await this.deps.storage.write(snapshotPath, currentContent);
    await this.deps.repository.createVersion({
      skillId: installed.id,
      versionNumber: versionNum,
      contentHash: installed.approvedContentHash ?? sha256(currentContent),
      storagePath: snapshotPath,
      activeReviewId: installed.activeReviewId,
      reason: "revert",
    });

    // Promote the target snapshot to live + advance the registry hash.
    await this.deps.storage.write(path, snapshotContent);
    await this.deps.repository.updateConfirmed({
      userId,
      skillId: installed.id,
      draft: { slug, roles: [] } as unknown as SkillDraft,
      review: { id: target.activeReviewId ?? "", candidateHash, policyVersion: SKILL_POLICY_VERSION } as unknown as SkillReview,
      idempotencyKey: `revert-${installed.id}-v${versionNumber}`,
      name: "",
      description: "",
    });
    return installed;
  }

  /** List version history summaries for an installed skill. */
  listVersions(userId: string, slug: string): Promise<SkillVersionSummary[]> {
    return this.deps.repository.listVersions(userId, slug);
  }

  quarantineOutdatedSkills(): Promise<number> {
    return this.deps.repository.quarantineOutdated(SKILL_POLICY_VERSION);
  }
}
