import type {
  InstalledSkill,
  SkillDraft,
  SkillLifecycleRepository,
  SkillReview,
  SkillVersionSnapshot,
  SkillVersionSummary,
} from "./service.js";

interface SkillDbPort {
  createSkillDraft(input: Record<string, unknown>): Promise<any>;
  getSkillDraft(id: string, userId: string): Promise<any | null>;
  updateSkillDraft(id: string, userId: string, patch: Record<string, unknown>): Promise<any>;
  createSkillReview(input: Record<string, unknown>): Promise<any>;
  getSkillReview(id: string, draftId: string): Promise<any | null>;
  findSkillConfirmation(userId: string, confirmationKey: string): Promise<any | null>;
  installReviewedSkill(input: Record<string, unknown>): Promise<any>;
  quarantineOutdatedSkills(activePolicyVersion: string): Promise<number>;
  findInstalledSkillBySlug(userId: string, slug: string): Promise<any | null>;
  updateInstalledSkill(input: Record<string, unknown>): Promise<any>;
  getNextSkillVersionNumber(skillId: string): Promise<number>;
  createSkillVersion(input: Record<string, unknown>): Promise<any>;
  listSkillVersions(userId: string, slug: string): Promise<any[]>;
  getSkillVersion(skillId: string, versionNumber: number): Promise<any | null>;
}

function mapDraft(row: any): SkillDraft {
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    source: row.source,
    originalContent: row.original_content,
    candidateContent: row.candidate_content,
    roles: row.selected_roles ?? [],
    status: row.status,
    version: row.version,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
  };
}

function mapReview(row: any): SkillReview {
  return {
    id: row.id,
    draftId: row.draft_id,
    draftVersion: row.draft_version,
    verdict: row.verdict,
    findings: row.findings ?? [],
    requiredCapabilities: row.required_capabilities ?? [],
    recommendedRoles: row.recommended_roles ?? [],
    originalHash: row.original_hash,
    candidateHash: row.candidate_hash,
    policyVersion: row.policy_version,
  };
}

function mapInstalled(row: any): InstalledSkill | null {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    approvedContentHash: row.approved_content_hash ?? null,
    activeReviewId: row.active_review_id ?? null,
    reviewPolicyVersion: row.review_policy_version ?? null,
  };
}

function mapVersion(row: any): SkillVersionSnapshot {
  return {
    id: row.id,
    skillId: row.skill_id,
    versionNumber: row.version_number,
    contentHash: row.content_hash,
    storagePath: row.storage_path,
    activeReviewId: row.active_review_id ?? null,
    snapshotReason: row.snapshot_reason,
    createdAt: row.created_at,
  };
}

export class SkillRepository implements SkillLifecycleRepository {
  constructor(private readonly db: SkillDbPort) {}

  async createDraft(input: Omit<SkillDraft, "id" | "status" | "version">): Promise<SkillDraft> {
    return mapDraft(await this.db.createSkillDraft({
      userId: input.userId,
      slug: input.slug,
      source: input.source,
      originalContent: input.originalContent,
      candidateContent: input.candidateContent,
      selectedRoles: input.roles,
      sessionId: input.sessionId,
    }));
  }

  async getDraft(id: string, userId: string): Promise<SkillDraft | null> {
    const row = await this.db.getSkillDraft(id, userId);
    return row ? mapDraft(row) : null;
  }

  async updateDraft(id: string, userId: string, patch: Partial<Pick<SkillDraft, "candidateContent" | "status" | "version">>): Promise<SkillDraft> {
    return mapDraft(await this.db.updateSkillDraft(id, userId, patch));
  }

  async createReview(input: Omit<SkillReview, "id">): Promise<SkillReview> {
    return mapReview(await this.db.createSkillReview(input));
  }

  async getReview(id: string, draftId: string): Promise<SkillReview | null> {
    const row = await this.db.getSkillReview(id, draftId);
    return row ? mapReview(row) : null;
  }

  findConfirmation(userId: string, idempotencyKey: string): Promise<any | null> {
    return this.db.findSkillConfirmation(userId, idempotencyKey);
  }

  installConfirmed(input: Parameters<SkillLifecycleRepository["installConfirmed"]>[0]): Promise<any> {
    return this.db.installReviewedSkill({
      slug: input.draft.slug,
      name: input.name,
      description: input.description,
      storagePath: `users/${input.userId}/${input.draft.slug}`,
      userId: input.userId,
      activeReviewId: input.review.id,
      approvedContentHash: input.review.candidateHash,
      reviewPolicyVersion: input.review.policyVersion,
      requiredCapabilities: input.review.requiredCapabilities,
      roles: input.draft.roles,
      confirmationKey: input.idempotencyKey,
    });
  }

  async findInstalled(userId: string, slug: string): Promise<InstalledSkill | null> {
    const row = await this.db.findInstalledSkillBySlug(userId, slug);
    return mapInstalled(row);
  }

  updateConfirmed(input: Parameters<SkillLifecycleRepository["updateConfirmed"]>[0]): Promise<any> {
    return this.db.updateInstalledSkill({
      skillId: input.skillId,
      slug: input.draft.slug,
      name: input.name,
      description: input.description,
      userId: input.userId,
      activeReviewId: input.review.id,
      approvedContentHash: input.review.candidateHash,
      reviewPolicyVersion: input.review.policyVersion,
      requiredCapabilities: input.review.requiredCapabilities,
      roles: input.draft.roles,
      confirmationKey: input.idempotencyKey,
    });
  }

  async nextVersionNumber(skillId: string): Promise<number> {
    return this.db.getNextSkillVersionNumber(skillId);
  }

  async createVersion(input: Parameters<SkillLifecycleRepository["createVersion"]>[0]): Promise<SkillVersionSnapshot> {
    return mapVersion(await this.db.createSkillVersion({
      skillId: input.skillId,
      versionNumber: input.versionNumber,
      contentHash: input.contentHash,
      storagePath: input.storagePath,
      activeReviewId: input.activeReviewId ?? null,
      snapshotReason: input.reason,
    }));
  }

  async listVersions(userId: string, slug: string): Promise<SkillVersionSummary[]> {
    const rows = await this.db.listSkillVersions(userId, slug);
    return rows.map((r) => ({
      versionNumber: r.version_number,
      snapshotReason: r.snapshot_reason,
      createdAt: r.created_at,
      contentHash: r.content_hash,
    }));
  }

  async getVersion(skillId: string, versionNumber: number): Promise<SkillVersionSnapshot | null> {
    const row = await this.db.getSkillVersion(skillId, versionNumber);
    return row ? mapVersion(row) : null;
  }

  quarantineOutdated(activePolicyVersion: string): Promise<number> {
    return this.db.quarantineOutdatedSkills(activePolicyVersion);
  }
}
