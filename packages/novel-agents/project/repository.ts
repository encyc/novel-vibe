import type {
  ProjectDeletionEnqueueResult,
  ProjectLifecycleCommand,
  ProjectLifecycleStatus,
  ProjectRow,
  ProjectTransitionResult,
} from "./types.js";
import type { ProjectDeletionJob, ProjectDeletionStage, ProjectDeletionStore } from "./deletion-worker.js";

export interface ProjectDeletionDataSource {
  claimProjectDeletionJobs(now: string, limit: number): Promise<ProjectDeletionJob[]>;
  freezeProjectForDeletion(jobId: string, projectId: string): Promise<boolean>;
  patchProjectDeletionJob(jobId: string, patch: Record<string, unknown>): Promise<void>;
  listProjectSessionIds(projectId: string): Promise<string[]>;
  insertMemoryExclusionRows(rows: Array<{ project_id: string; deleted_session_id: string; external_memory_id: string }>): Promise<void>;
  purgeProjectDatabase(jobId: string, projectId: string): Promise<void>;
  updateProject(projectId: string, patch: Record<string, unknown>): Promise<ProjectRow | null>;
}

export interface ProjectDataSource {
  getProject(projectId: string): Promise<ProjectRow | null>;
  listProjects(ownerId?: string, lifecycleStatus?: ProjectLifecycleStatus): Promise<ProjectRow[]>;
  updateProject(projectId: string, patch: Record<string, unknown>): Promise<ProjectRow | null>;
  transitionProjectLifecycle(
    projectId: string,
    command: ProjectLifecycleCommand,
  ): Promise<ProjectTransitionResult>;
  enqueueProjectDeletion(
    projectId: string,
    requestedBy: string,
    jobId: string,
  ): Promise<ProjectDeletionEnqueueResult>;
}

export class ProjectRepository {
  constructor(
    private readonly dataSource: ProjectDataSource,
    private readonly deletionDataSource: ProjectDataSource = dataSource,
  ) {}

  list(lifecycleStatus: ProjectLifecycleStatus): Promise<ProjectRow[]> {
    return this.dataSource.listProjects(undefined, lifecycleStatus);
  }

  getProject(projectId: string): Promise<ProjectRow | null> {
    return this.dataSource.getProject(projectId);
  }

  update(projectId: string, patch: Record<string, unknown>): Promise<ProjectRow | null> {
    return this.dataSource.updateProject(projectId, patch);
  }

  transition(
    projectId: string,
    command: ProjectLifecycleCommand,
  ): Promise<ProjectTransitionResult> {
    return this.dataSource.transitionProjectLifecycle(projectId, command);
  }

  enqueueDeletion(
    projectId: string,
    requestedBy: string,
    jobId: string,
  ): Promise<ProjectDeletionEnqueueResult> {
    return this.deletionDataSource.enqueueProjectDeletion(projectId, requestedBy, jobId);
  }
}

export class ProjectDeletionRepository implements ProjectDeletionStore {
  constructor(private readonly dataSource: ProjectDeletionDataSource) {}
  claimDeletionJobs(now: string, limit: number) { return this.dataSource.claimProjectDeletionJobs(now, limit); }
  async freezeProject(jobId: string, projectId: string) {
    if (!await this.dataSource.freezeProjectForDeletion(jobId, projectId)) {
      throw new Error("Project deletion freeze is waiting for running memory jobs");
    }
  }
  listProjectSessionIds(projectId: string) { return this.dataSource.listProjectSessionIds(projectId); }
  async addMemoryExclusions(projectId: string, rows: Array<{ sessionId: string; memoryId: string }>) {
    await this.dataSource.insertMemoryExclusionRows(rows.map((row) => ({
      project_id: projectId, deleted_session_id: row.sessionId, external_memory_id: row.memoryId,
    })));
  }
  async advanceDeletionJob(jobId: string, stage: ProjectDeletionStage) {
    await this.dataSource.patchProjectDeletionJob(jobId, { stage, attempts: 0, next_attempt_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() });
  }
  async retryDeletionJob(jobId: string, stage: ProjectDeletionStage, attempts: number, nextAttemptAt: string, error: string) {
    await this.dataSource.patchProjectDeletionJob(jobId, { stage: "failed", resume_stage: stage, attempts, next_attempt_at: nextAttemptAt, last_error: error, updated_at: new Date().toISOString() });
  }
  purgeProjectDatabase(jobId: string, projectId: string) { return this.dataSource.purgeProjectDatabase(jobId, projectId); }
}
