import type { SupportedLanguage } from "../lib/language.js";

export type ProjectLifecycleStatus = "active" | "archived" | "trash";
export type ProjectLifecycleCommand = "archive" | "trash" | "restore";
export type ProjectWritingStage = "planning" | "drafting" | "revising" | "completed";

export interface ProjectRow {
  id: string;
  creative_language: SupportedLanguage;
  lifecycle_status: ProjectLifecycleStatus;
  pre_trash_status?: Exclude<ProjectLifecycleStatus, "trash"> | null;
  archived_at?: string | null;
  deleted_at?: string | null;
  purge_after?: string | null;
  [key: string]: unknown;
}

export type ProjectTransitionResult =
  | { outcome: "ok"; project: ProjectRow }
  | { outcome: "not_found" }
  | { outcome: "busy"; sessionId: string }
  | { outcome: "invalid"; from: ProjectLifecycleStatus; command: ProjectLifecycleCommand }
  | { outcome: "purge_in_progress" };

export type ProjectDeletionEnqueueResult =
  | { outcome: "ok"; jobId: string }
  | { outcome: "not_found" }
  | { outcome: "busy"; sessionId: string }
  | { outcome: "invalid"; from: ProjectLifecycleStatus };

export type ProjectErrorCode =
  | "PROJECT_NOT_FOUND"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "PROJECT_READ_ONLY"
  | "RESOURCE_BUSY"
  | "PURGE_IN_PROGRESS"
  | "INVALID_PROJECT_INPUT";

export class ProjectDomainError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectDomainError";
  }
}
