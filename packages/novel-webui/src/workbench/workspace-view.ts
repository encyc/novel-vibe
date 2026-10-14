/**
 * Right-panel page registry. Chat stays the permanent center column; the
 * workspace column hosts selectable pages, with the Agent task page appearing
 * only while a delegation drill is active. The active view lives in the URL
 * (`?view=review|agent`; absent means the manuscript workspace) so every tab
 * is deep-linkable and browser history moves between them.
 */
export type WorkspaceViewId = "workspace" | "review" | "agent";

const VIEW_IDS: readonly WorkspaceViewId[] = ["workspace", "review", "agent"];

export function isWorkspaceViewId(value: unknown): value is WorkspaceViewId {
  return typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);
}

/** An absent or unknown ?view falls back to the manuscript workspace. */
export function resolveWorkspaceView(raw: string | null): WorkspaceViewId {
  return isWorkspaceViewId(raw) ? raw : "workspace";
}
