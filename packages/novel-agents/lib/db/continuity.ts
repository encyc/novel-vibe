import type { ContinuityJob } from "../../continuity/worker.js";
import type { DbRequestContext } from "./context.js";

export async function enqueueContinuityJob(ctx: DbRequestContext, input: {
  projectId: string;
  chapterNumber: number;
  chapterPath: string;
  confirmedHash: string;
}): Promise<void> {
  const conflict = encodeURIComponent("project_id,chapter_path,confirmed_hash");
  const res = await fetch(`${ctx.pgUrl}/continuity_jobs?on_conflict=${conflict}`, {
    method: "POST",
    headers: ctx.headers({ Prefer: "resolution=ignore-duplicates" }),
    body: JSON.stringify({
      project_id: input.projectId,
      chapter_number: input.chapterNumber,
      chapter_path: input.chapterPath,
      confirmed_hash: input.confirmedHash,
    }),
  });
  if (!res.ok) throw new Error(`Enqueue continuity job failed [${res.status}]: ${await res.text()}`);
}

export async function claimContinuityJobs(
  ctx: DbRequestContext,
  now: string,
  limit: number,
): Promise<ContinuityJob[]> {
  const res = await fetch(`${ctx.pgUrl}/rpc/claim_continuity_jobs`, {
    method: "POST",
    headers: ctx.headers(),
    body: JSON.stringify({ p_now: now, p_limit: limit, p_lease_seconds: 300 }),
  });
  if (!res.ok) throw new Error(`Claim continuity jobs failed [${res.status}]: ${await res.text()}`);
  return res.json();
}

async function patchContinuityJob(
  ctx: DbRequestContext,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${ctx.pgUrl}/continuity_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: ctx.headers(),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Update continuity job failed [${res.status}]: ${await res.text()}`);
}

export async function completeContinuityJob(ctx: DbRequestContext, jobId: string): Promise<void> {
  const now = new Date().toISOString();
  return patchContinuityJob(ctx, jobId, {
    status: "complete", completed_at: now, lease_id: null, lease_expires_at: null, last_error: null,
  });
}

export async function retryContinuityJob(
  ctx: DbRequestContext,
  jobId: string,
  attempts: number,
  nextAttemptAt: string,
  error: string,
): Promise<void> {
  return patchContinuityJob(ctx, jobId, {
    status: "pending", attempts, next_attempt_at: nextAttemptAt, last_error: error,
    lease_id: null, lease_expires_at: null,
  });
}

export async function failContinuityJob(ctx: DbRequestContext, jobId: string, error: string): Promise<void> {
  return patchContinuityJob(ctx, jobId, {
    status: "failed", last_error: error, completed_at: new Date().toISOString(),
    lease_id: null, lease_expires_at: null,
  });
}
