import crypto from "node:crypto";
import type {
  ProjectDeletionEnqueueResult,
  ProjectLifecycleCommand,
  ProjectLifecycleStatus,
  ProjectRow,
  ProjectTransitionResult,
} from "../../project/types.js";
import type { ProjectDeletionJob } from "../../project/deletion-worker.js";
import type { SupportedLanguage } from "../language.js";

import type { DbRequestContext } from "./context.js";

export async function createProject(ctx: DbRequestContext, params: {
    ownerId?: string;
    title: string;
    genre?: string;
    synopsis?: string;
    creativeLanguage?: SupportedLanguage;
  }): Promise<ProjectRow> {
    const storagePath = `novels/${crypto.randomUUID()}`;
    const res = await fetch(`${ctx.pgUrl}/projects`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        ...(params.ownerId ? { owner_id: params.ownerId } : {}),
        title: params.title,
        genre: params.genre ?? null,
        synopsis: params.synopsis ?? null,
        creative_language: params.creativeLanguage ?? "zh-CN",
        storage_path: storagePath,
      }),
    });
    if (!res.ok) throw new Error(`Create project failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }

export async function getProject(ctx: DbRequestContext, projectId: string): Promise<ProjectRow | null> {
    const url = `${ctx.pgUrl}/projects?id=eq.${projectId}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get project failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function updateProject(ctx: DbRequestContext, projectId: string, patch: Record<string, unknown>): Promise<ProjectRow | null> {
    const res = await fetch(`${ctx.pgUrl}/projects?id=eq.${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Update project failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function transitionProjectLifecycle(ctx: DbRequestContext, projectId: string, command: ProjectLifecycleCommand): Promise<ProjectTransitionResult> {
    const res = await fetch(`${ctx.pgUrl}/rpc/transition_project_lifecycle`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_project_id: projectId, p_command: command }),
    });
    if (!res.ok) {
      throw new Error(`Project lifecycle transition failed [${res.status}]: ${await res.text()}`);
    }
    return await res.json() as ProjectTransitionResult;
  }

export async function enqueueProjectDeletion(ctx: DbRequestContext, projectId: string, requestedBy: string, jobId: string): Promise<ProjectDeletionEnqueueResult> {
    const res = await fetch(`${ctx.pgUrl}/rpc/enqueue_project_deletion`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_project_id: projectId,
        p_requested_by: requestedBy,
        p_job_id: jobId,
      }),
    });
    if (!res.ok) throw new Error(`Enqueue project deletion failed [${res.status}]: ${await res.text()}`);
    return await res.json() as ProjectDeletionEnqueueResult;
  }

export async function claimProjectDeletionJobs(ctx: DbRequestContext, now: string, limit: number): Promise<ProjectDeletionJob[]> {
    const res = await fetch(`${ctx.pgUrl}/rpc/claim_project_deletion_jobs`, {
      method: "POST", headers: ctx.headers(), body: JSON.stringify({ p_now: now, p_limit: limit }),
    });
    if (!res.ok) throw new Error(`Claim project deletion jobs failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function freezeProjectForDeletion(ctx: DbRequestContext, jobId: string, projectId: string): Promise<boolean> {
    const res = await fetch(`${ctx.pgUrl}/rpc/freeze_project_for_deletion`, {
      method: "POST", headers: ctx.headers(), body: JSON.stringify({ p_job_id: jobId, p_project_id: projectId }),
    });
    if (!res.ok) throw new Error(`Freeze project deletion failed [${res.status}]: ${await res.text()}`);
    return Boolean(await res.json());
  }

export async function patchProjectDeletionJob(ctx: DbRequestContext, jobId: string, patch: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/project_deletion_jobs?id=eq.${encodeURIComponent(jobId)}`, {
      method: "PATCH", headers: ctx.headers(), body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Update project deletion job failed [${res.status}]: ${await res.text()}`);
  }

export async function purgeProjectDatabase(ctx: DbRequestContext, jobId: string, projectId: string): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/rpc/purge_project_database`, {
      method: "POST", headers: ctx.headers(), body: JSON.stringify({ p_job_id: jobId, p_project_id: projectId }),
    });
    if (!res.ok) throw new Error(`Purge project database failed [${res.status}]: ${await res.text()}`);
  }

export async function listProjects(ctx: DbRequestContext, ownerId?: string, lifecycleStatus?: ProjectLifecycleStatus): Promise<ProjectRow[]> {
    let url = `${ctx.pgUrl}/projects?order=last_activity_at.desc,id.desc`;
    if (ownerId) url += `&owner_id=eq.${ownerId}`;
    if (lifecycleStatus) url += `&lifecycle_status=eq.${lifecycleStatus}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List projects failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function createTask(ctx: DbRequestContext, params: {
    projectId: string;
    agent: string;
    taskType: string;
    description?: string;
    parentTaskId?: string;
    inputRefs?: Array<{ type: string; path: string }>;
    outputPath?: string;
  }): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/agent_tasks`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        project_id: params.projectId,
        agent: params.agent,
        task_type: params.taskType,
        description: params.description ?? null,
        parent_task_id: params.parentTaskId ?? null,
        input_refs: params.inputRefs ?? [],
        output_path: params.outputPath ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Create task failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }

export async function updateTaskStatus(ctx: DbRequestContext, taskId: string, status: string, reviewNote?: string): Promise<void> {
    const url = `${ctx.pgUrl}/agent_tasks?id=eq.${taskId}`;
    const body: Record<string, unknown> = { status };
    if (reviewNote) body.review_note = reviewNote;
    if (status === "approved" || status === "rejected") body.completed_at = new Date().toISOString();

    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Update task failed [${res.status}]: ${await res.text()}`);
  }

export async function listTasks(ctx: DbRequestContext, projectId: string, limit = 50): Promise<any[]> {
    const url = `${ctx.pgUrl}/agent_tasks?project_id=eq.${projectId}&order=created_at.desc&limit=${limit}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List tasks failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function ownsProject(ctx: DbRequestContext, projectId: string, userId: string): Promise<boolean> {
    const url = `${ctx.pgUrl}/projects?id=eq.${encodeURIComponent(projectId)}`
      + `&owner_id=eq.${encodeURIComponent(userId)}&select=id`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Project ownership query failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows.length === 1;
  }

export async function countProjectsByOwner(ctx: DbRequestContext, userId: string): Promise<number> {
    const url = `${ctx.pgUrl}/projects?owner_id=eq.${encodeURIComponent(userId)}&select=id&limit=4`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Count projects failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length : 0;
  }
