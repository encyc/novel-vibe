import { NovelOrchestrator } from "../agents.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { normalizeSupportedLanguage } from "../lib/language.js";
import { DbClient } from "../lib/db.js";
import { sha256Content } from "../lib/storage.js";
import { createContentStore } from "../lib/content-store-factory.js";
import type { EntitlementPort, TurnUsageBilling } from "../lib/policy-ports.js";
import type { ContinuityJob } from "./worker.js";

interface ContinuityProject {
  owner_id?: string | null;
  lifecycle_status?: string;
  creative_language?: unknown;
}

interface ContinuityOrchestrator {
  init(): Promise<void>;
  runContinuityCheckpoint(chapterNumber: number, path: string, jobId: string, confirmedHash?: string): Promise<void>;
}

export function createContinuityExecutor(dependencies: {
  getProject(projectId: string): Promise<ContinuityProject | null>;
  readChapter(projectId: string, path: string): Promise<string>;
  createOrchestrator(project: ContinuityProject, job: ContinuityJob): ContinuityOrchestrator;
}): (job: ContinuityJob) => Promise<void> {
  return async (job) => {
    const project = await dependencies.getProject(job.project_id);
    if (!project || project.lifecycle_status !== "active" || !project.owner_id) return;

    const content = await dependencies.readChapter(job.project_id, job.chapter_path);
    const { frontmatter } = parseFrontmatter(content);
    if (sha256Content(content) !== job.confirmed_hash || frontmatter.status !== "confirmed") return;

    const orchestrator = dependencies.createOrchestrator(project, job);
    await orchestrator.init();
    await orchestrator.runContinuityCheckpoint(job.chapter_number, job.chapter_path, job.id, job.confirmed_hash);
  };
}

/**
 * Build the system-scoped continuity executor.
 *
 * This module is wiring: it resolves the project, reads the confirmed chapter and
 * assembles an orchestrator. The billing and entitlement ports are therefore
 * injected rather than constructed here — `continuity/` is creation-core, so it
 * must not reach for the SaaS implementations. The composition root
 * (`server.ts`) owns that choice.
 */
export function createSystemContinuityExecutor(
  db: DbClient,
  ports: { billing: TurnUsageBilling; entitlements: EntitlementPort },
): (job: ContinuityJob) => Promise<void> {
  return createContinuityExecutor({
    getProject: (projectId) => db.getProject(projectId),
    readChapter: (projectId, path) => createContentStore({
      mode: "system",
      token: db.storageToken,
      bucket: "novels",
      projectId,
    }).read(path),
    createOrchestrator: (project, job) => new NovelOrchestrator({
      token: db.storageToken,
      projectId: job.project_id,
      billing: ports.billing,
      entitlements: ports.entitlements,
      userId: String(project.owner_id),
      systemJobId: job.id,
      creativeLanguage: normalizeSupportedLanguage(project.creative_language),
    }),
  });
}
