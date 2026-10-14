import { randomUUID } from "node:crypto";
import { isSupportedLanguage, type SupportedLanguage } from "../lib/language.js";
import {
  ProjectDomainError,
  type ProjectDeletionEnqueueResult,
  type ProjectLifecycleCommand,
  type ProjectLifecycleStatus,
  type ProjectRow,
  type ProjectTransitionResult,
  type ProjectWritingStage,
} from "./types.js";

export interface ProjectRepositoryPort {
  list(lifecycleStatus: ProjectLifecycleStatus): Promise<ProjectRow[]>;
  getProject(projectId: string): Promise<ProjectRow | null>;
  update(projectId: string, patch: Record<string, unknown>): Promise<ProjectRow | null>;
  transition(projectId: string, command: ProjectLifecycleCommand): Promise<ProjectTransitionResult>;
  enqueueDeletion(projectId: string, requestedBy: string, jobId: string): Promise<ProjectDeletionEnqueueResult>;
}

const WRITING_STAGES = new Set<ProjectWritingStage>(["planning", "drafting", "revising", "completed"]);

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepositoryPort,
    private readonly uuid: () => string = randomUUID,
  ) {}

  list(input: { lifecycleStatus: ProjectLifecycleStatus }): Promise<ProjectRow[]> {
    return this.repository.list(input.lifecycleStatus);
  }

  async get(projectId: string): Promise<ProjectRow> {
    const project = await this.repository.getProject(projectId);
    if (!project) throw new ProjectDomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    return project;
  }

  async update(projectId: string, input: {
    title?: string;
    genre?: string | null;
    synopsis?: string | null;
    writingStage?: ProjectWritingStage;
    creativeLanguage?: SupportedLanguage;
  }): Promise<ProjectRow> {
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new ProjectDomainError("INVALID_PROJECT_INPUT", "Project title is required", 400);
      patch.title = title;
    }
    if (input.genre !== undefined) patch.genre = input.genre;
    if (input.synopsis !== undefined) patch.synopsis = input.synopsis;
    if (input.writingStage !== undefined) {
      if (!WRITING_STAGES.has(input.writingStage)) {
        throw new ProjectDomainError("INVALID_PROJECT_INPUT", "Invalid writing stage", 400);
      }
      patch.writing_stage = input.writingStage;
    }
    if (input.creativeLanguage !== undefined) {
      if (!isSupportedLanguage(input.creativeLanguage)) {
        throw new ProjectDomainError("INVALID_PROJECT_INPUT", "Unsupported creative language", 400);
      }
      patch.creative_language = input.creativeLanguage;
    }
    const project = await this.repository.update(projectId, patch);
    if (!project) throw new ProjectDomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    return project;
  }

  async permanentlyDelete(input: { projectId: string; userId: string }): Promise<{ jobId: string }> {
    const result = await this.repository.enqueueDeletion(input.projectId, input.userId, this.uuid());
    if (result.outcome === "ok") return { jobId: result.jobId };
    if (result.outcome === "not_found") {
      throw new ProjectDomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    if (result.outcome === "busy") {
      throw new ProjectDomainError("RESOURCE_BUSY", "Project has a Session that is still processing", 409, {
        sessionId: result.sessionId,
      });
    }
    throw new ProjectDomainError(
      "INVALID_LIFECYCLE_TRANSITION",
      "Only Projects in trash can be permanently deleted",
      409,
      { lifecycleStatus: result.from, command: "permanent_delete" },
    );
  }

  archive(input: { projectId: string }): Promise<ProjectRow> {
    return this.runTransition(input.projectId, "archive");
  }

  trash(input: { projectId: string }): Promise<ProjectRow> {
    return this.runTransition(input.projectId, "trash");
  }

  restore(input: { projectId: string }): Promise<ProjectRow> {
    return this.runTransition(input.projectId, "restore");
  }

  async assertProjectWritable(projectId: string): Promise<void> {
    const project = await this.repository.getProject(projectId);
    if (!project) {
      throw new ProjectDomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    if (project.lifecycle_status !== "active") {
      throw new ProjectDomainError(
        "PROJECT_READ_ONLY",
        `Project is ${project.lifecycle_status} and cannot be modified`,
        409,
        { lifecycleStatus: project.lifecycle_status },
      );
    }
  }

  private async runTransition(
    projectId: string,
    command: ProjectLifecycleCommand,
  ): Promise<ProjectRow> {
    const result = await this.repository.transition(projectId, command);
    if (result.outcome === "ok") return result.project;
    if (result.outcome === "not_found") {
      throw new ProjectDomainError("PROJECT_NOT_FOUND", "Project not found", 404);
    }
    if (result.outcome === "busy") {
      throw new ProjectDomainError(
        "RESOURCE_BUSY",
        "Project has a Session that is still processing",
        409,
        { sessionId: result.sessionId },
      );
    }
    if (result.outcome === "purge_in_progress") {
      throw new ProjectDomainError(
        "PURGE_IN_PROGRESS",
        "Project deletion has started and can no longer be restored",
        409,
      );
    }
    throw new ProjectDomainError(
      "INVALID_LIFECYCLE_TRANSITION",
      `Cannot ${result.command} a Project in ${result.from} state`,
      409,
      { command: result.command, lifecycleStatus: result.from },
    );
  }
}
