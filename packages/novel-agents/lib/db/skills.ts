import type { DbRequestContext } from "./context.js";

const SKILL_WRITE_HEADERS: Record<string, string> = {
    "Accept-Profile": "public",
    "Content-Profile": "public",
};

export async function listSkillRegistry(ctx: DbRequestContext, userId?: string): Promise<any[]> {
    let url = `${ctx.pgUrl}/skill_registry?order=name.asc`;
    if (userId) {
      // Return built-in skills (user_id IS NULL) + this user's installed skills
      url += `&or=(user_id.is.null,user_id.eq.${encodeURIComponent(userId)})`;
    }
    const skH = { "Accept-Profile": "public" };
    const res = await fetch(url, { headers: ctx.headers(skH) });
    if (!res.ok) throw new Error(`List skill_registry failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function getSkillRegistrySource(ctx: DbRequestContext, slug: string): Promise<string | null> {
    const url = `${ctx.pgUrl}/skill_registry?slug=eq.${encodeURIComponent(slug)}&select=source`;
    const skH = { "Accept-Profile": "public" };
    const res = await fetch(url, { headers: ctx.headers(skH) });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0]?.source ?? null;
  }

export async function getSkillFromRegistry(ctx: DbRequestContext, slug: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/skill_registry?slug=eq.${encodeURIComponent(slug)}`;
    const skH = { "Accept-Profile": "public" };
    const res = await fetch(url, { headers: ctx.headers(skH) });
    if (!res.ok) throw new Error(`Get skill_registry failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function getSkillForUser(ctx: DbRequestContext, slug: string, userId?: string): Promise<any | null> {
    let url = `${ctx.pgUrl}/skill_registry?slug=eq.${encodeURIComponent(slug)}`;
    // built-in (user_id null) OR this user's
    url += `&or=(user_id.is.null${userId ? `,user_id.eq.${encodeURIComponent(userId)}` : ""})`;
    // 'built-in' sorts before 'user' alphabetically → built-in wins on collision
    url += `&order=source.asc&limit=1`;
    const skH = { "Accept-Profile": "public" };
    const res = await fetch(url, { headers: ctx.headers(skH) });
    if (!res.ok) throw new Error(`Get skill_for_user failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function installSkill(ctx: DbRequestContext, params: {
    slug: string;
    name: string;
    description?: string;
    storagePath: string;
    version?: string;
    userId?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    const body: Record<string, unknown> = {
      slug: params.slug,
      name: params.name,
      description: params.description ?? null,
      storage_path: params.storagePath,
      version: params.version ?? "1.0.0",
      user_id: params.userId ?? null,
      source: params.source ?? "user",
      metadata: params.metadata ?? null,
    };
    const res = await fetch(`${ctx.pgUrl}/skill_registry`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation", ...SKILL_WRITE_HEADERS }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Install skill failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }

export async function createSkillDraft(ctx: DbRequestContext, params: {
    userId: string; slug: string; source: string; originalContent: string;
    candidateContent: string; selectedRoles: string[]; sessionId?: string;
  }): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/skill_drafts`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation", ...SKILL_WRITE_HEADERS }),
      body: JSON.stringify({
        user_id: params.userId,
        slug: params.slug,
        source: params.source,
        original_content: params.originalContent,
        candidate_content: params.candidateContent,
        selected_roles: params.selectedRoles,
        session_id: params.sessionId ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Create skill draft failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0];
  }

export async function getSkillDraft(ctx: DbRequestContext, id: string, userId: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/skill_drafts?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Get skill draft failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0] ?? null;
  }

export async function updateSkillDraft(ctx: DbRequestContext, id: string, userId: string, patch: Record<string, unknown>): Promise<any> {
    const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.candidateContent !== undefined) body.candidate_content = patch.candidateContent;
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.version !== undefined) body.version = patch.version;
    const url = `${ctx.pgUrl}/skill_drafts?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers({ Prefer: "return=representation", ...SKILL_WRITE_HEADERS }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Update skill draft failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0];
  }

export async function createSkillReview(ctx: DbRequestContext, params: Record<string, any>): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/skill_reviews`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation", ...SKILL_WRITE_HEADERS }),
      body: JSON.stringify({
        draft_id: params.draftId,
        draft_version: params.draftVersion,
        verdict: params.verdict,
        findings: params.findings,
        required_capabilities: params.requiredCapabilities,
        recommended_roles: params.recommendedRoles,
        original_hash: params.originalHash,
        candidate_hash: params.candidateHash,
        policy_version: params.policyVersion,
        rules_version: params.rulesVersion ?? "1",
        reviewer_provider: params.reviewerProvider ?? null,
        reviewer_model: params.reviewerModel ?? null,
        prompt_version: params.promptVersion ?? "1",
        failure_message: params.failureMessage ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Create skill review failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0];
  }

export async function getSkillReview(ctx: DbRequestContext, id: string, draftId: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/skill_reviews?id=eq.${encodeURIComponent(id)}&draft_id=eq.${encodeURIComponent(draftId)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Get skill review failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0] ?? null;
  }

export async function findSkillConfirmation(ctx: DbRequestContext, userId: string, confirmationKey: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/skill_registry?user_id=eq.${encodeURIComponent(userId)}&confirmation_key=eq.${encodeURIComponent(confirmationKey)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Find skill confirmation failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0] ?? null;
  }

export async function listSkillRoles(ctx: DbRequestContext, skillId: string): Promise<string[]> {
    const url = `${ctx.pgUrl}/skill_roles?skill_id=eq.${encodeURIComponent(skillId)}&select=role`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`List skill roles failed [${res.status}]: ${await res.text()}`);
    return (await res.json()).map((row: any) => row.role);
  }

export async function installReviewedSkill(ctx: DbRequestContext, params: {
    slug: string; name: string; description: string; storagePath: string; userId: string;
    activeReviewId: string; approvedContentHash: string; reviewPolicyVersion: string;
    requiredCapabilities: string[]; roles: string[]; confirmationKey: string;
  }): Promise<any> {
    const registry = await fetch(`${ctx.pgUrl}/skill_registry`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation", ...SKILL_WRITE_HEADERS }),
      body: JSON.stringify({
        slug: params.slug,
        name: params.name,
        description: params.description,
        storage_path: params.storagePath,
        user_id: params.userId,
        source: "user",
        active_review_id: params.activeReviewId,
        approved_content_hash: params.approvedContentHash,
        review_policy_version: params.reviewPolicyVersion,
        review_status: "approved",
        confirmation_key: params.confirmationKey,
        metadata: { requiredCapabilities: params.requiredCapabilities },
      }),
    });
    if (!registry.ok) throw new Error(`Install reviewed skill failed [${registry.status}]: ${await registry.text()}`);
    const installed = (await registry.json())[0];
    if (params.roles.length > 0) {
      const roles = await fetch(`${ctx.pgUrl}/skill_roles`, {
        method: "POST",
        headers: ctx.headers(SKILL_WRITE_HEADERS),
        body: JSON.stringify(params.roles.map((role) => ({ skill_id: installed.id, role }))),
      });
      if (!roles.ok) throw new Error(`Install skill roles failed [${roles.status}]: ${await roles.text()}`);
    }
    return installed;
  }

export async function quarantineOutdatedSkills(ctx: DbRequestContext, activePolicyVersion: string): Promise<number> {
    const url = `${ctx.pgUrl}/skill_registry?source=eq.user&review_status=eq.approved&review_policy_version=neq.${encodeURIComponent(activePolicyVersion)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers({ Prefer: "return=representation", ...SKILL_WRITE_HEADERS }),
      body: JSON.stringify({ review_status: "quarantined" }),
    });
    if (!res.ok) throw new Error(`Quarantine skills failed [${res.status}]: ${await res.text()}`);
    return (await res.json()).length;
  }

export async function uninstallSkill(ctx: DbRequestContext, slug: string, userId?: string): Promise<void> {
    let url = `${ctx.pgUrl}/skill_registry?slug=eq.${encodeURIComponent(slug)}`;
    // Only allow deleting user-installed skills for this user
    if (userId) {
      url += `&user_id=eq.${encodeURIComponent(userId)}`;
    }
    const res = await fetch(url, {
      method: "DELETE",
      headers: ctx.headers(SKILL_WRITE_HEADERS),
    });
    if (!res.ok) throw new Error(`Uninstall skill failed [${res.status}]: ${await res.text()}`);
  }

export async function findInstalledSkillBySlug(ctx: DbRequestContext, userId: string, slug: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/skill_registry?slug=eq.${encodeURIComponent(slug)}`
      + `&source=eq.user&user_id=eq.${encodeURIComponent(userId)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Find installed skill failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0] ?? null;
  }

export async function updateInstalledSkill(ctx: DbRequestContext, params: {
    skillId: string; slug: string; name: string; description: string;
    userId: string; activeReviewId: string; approvedContentHash: string;
    reviewPolicyVersion: string; requiredCapabilities: string[];
    roles: string[]; confirmationKey: string;
  }): Promise<any> {
    const url = `${ctx.pgUrl}/skill_registry?id=eq.${encodeURIComponent(params.skillId)}&user_id=eq.${encodeURIComponent(params.userId)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers({ Prefer: "return=representation", ...SKILL_WRITE_HEADERS }),
      body: JSON.stringify({
        name: params.name,
        description: params.description,
        active_review_id: params.activeReviewId,
        approved_content_hash: params.approvedContentHash,
        review_policy_version: params.reviewPolicyVersion,
        review_status: "approved",
        confirmation_key: params.confirmationKey,
        metadata: { requiredCapabilities: params.requiredCapabilities },
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`Update installed skill failed [${res.status}]: ${await res.text()}`);
    const updated = (await res.json())[0];
    // Replace roles: delete then insert.
    if (params.roles.length > 0) {
      const delRes = await fetch(`${ctx.pgUrl}/skill_roles?skill_id=eq.${encodeURIComponent(params.skillId)}`, {
        method: "DELETE",
        headers: ctx.headers(SKILL_WRITE_HEADERS),
      });
      if (!delRes.ok) throw new Error(`Replace skill roles (delete) failed [${delRes.status}]: ${await delRes.text()}`);
      const roles = await fetch(`${ctx.pgUrl}/skill_roles`, {
        method: "POST",
        headers: ctx.headers(SKILL_WRITE_HEADERS),
        body: JSON.stringify(params.roles.map((role) => ({ skill_id: params.skillId, role }))),
      });
      if (!roles.ok) throw new Error(`Replace skill roles (insert) failed [${roles.status}]: ${await roles.text()}`);
    }
    return updated;
  }

export async function getNextSkillVersionNumber(ctx: DbRequestContext, skillId: string): Promise<number> {
    const url = `${ctx.pgUrl}/skill_versions?skill_id=eq.${encodeURIComponent(skillId)}&select=version_number&order=version_number.desc&limit=1`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Get next skill version failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ? (rows[0].version_number as number) + 1 : 1;
  }

export async function createSkillVersion(ctx: DbRequestContext, params: {
    skillId: string; versionNumber: number; contentHash: string;
    storagePath: string; activeReviewId?: string | null; snapshotReason: string;
  }): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/skill_versions`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation", ...SKILL_WRITE_HEADERS }),
      body: JSON.stringify({
        skill_id: params.skillId,
        version_number: params.versionNumber,
        content_hash: params.contentHash,
        storage_path: params.storagePath,
        active_review_id: params.activeReviewId ?? null,
        snapshot_reason: params.snapshotReason,
      }),
    });
    if (!res.ok) throw new Error(`Create skill version failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0];
  }

export async function listSkillVersions(ctx: DbRequestContext, userId: string, slug: string): Promise<any[]> {
    // First resolve the skill_id, then list versions.
    const reg = await findInstalledSkillBySlug(ctx, userId, slug);
    if (!reg) return [];
    const url = `${ctx.pgUrl}/skill_versions?skill_id=eq.${encodeURIComponent(reg.id)}`
      + `&order=version_number.desc`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`List skill versions failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function getSkillVersion(ctx: DbRequestContext, skillId: string, versionNumber: number): Promise<any | null> {
    const url = `${ctx.pgUrl}/skill_versions?skill_id=eq.${encodeURIComponent(skillId)}`
      + `&version_number=eq.${versionNumber}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Get skill version failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0] ?? null;
  }

export async function listWorkspaceSkills(ctx: DbRequestContext, workspaceId: string): Promise<any[]> {
    const url = `${ctx.pgUrl}/workspace_skills?workspace_id=eq.${encodeURIComponent(workspaceId)}&order=created_at.asc`;
    const skH = { "Accept-Profile": "public" };
    const res = await fetch(url, { headers: ctx.headers(skH) });
    if (!res.ok) throw new Error(`List workspace_skills failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function getWorkspaceSkill(ctx: DbRequestContext, workspaceId: string, skillSlug: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/workspace_skills?workspace_id=eq.${encodeURIComponent(workspaceId)}&skill_slug=eq.${encodeURIComponent(skillSlug)}`;
    const skH = { "Accept-Profile": "public" };
    const res = await fetch(url, { headers: ctx.headers(skH) });
    if (!res.ok) throw new Error(`Get workspace_skill failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function toggleWorkspaceSkill(ctx: DbRequestContext, workspaceId: string, skillSlug: string, enabled: boolean): Promise<void> {
    const existing = await getWorkspaceSkill(ctx, workspaceId, skillSlug);
    if (existing) {
      const url = `${ctx.pgUrl}/workspace_skills?workspace_id=eq.${encodeURIComponent(workspaceId)}&skill_slug=eq.${encodeURIComponent(skillSlug)}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: ctx.headers(SKILL_WRITE_HEADERS),
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`Toggle workspace_skill failed [${res.status}]: ${await res.text()}`);
    } else {
      const res = await fetch(`${ctx.pgUrl}/workspace_skills`, {
        method: "POST",
        headers: ctx.headers(SKILL_WRITE_HEADERS),
        body: JSON.stringify({
          workspace_id: workspaceId,
          skill_slug: skillSlug,
          enabled,
        }),
      });
      if (!res.ok) throw new Error(`Create workspace_skill failed [${res.status}]: ${await res.text()}`);
    }
  }
