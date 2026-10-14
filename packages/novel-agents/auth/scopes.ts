export type ApiScope =
  | "profile:read"
  | "profile:write"
  | "tokens:manage"
  | "billing:read"
  | "billing:purchase"
  | "projects:read"
  | "projects:write"
  | "projects:lifecycle"
  | "projects:delete"
  | "documents:read"
  | "documents:write"
  | "documents:export"
  | "documents:delete"
  | "sessions:read"
  | "sessions:write"
  | "sessions:delete"
  | "agents:run"
  | "skills:read"
  | "skills:write"
  | "skills:manage";

export interface ApiScopeMetadata {
  description: string;
  delegable: boolean;
}

export const API_SCOPES: Record<ApiScope, ApiScopeMetadata> = {
  "profile:read": { description: "Read the user's profile.", delegable: true },
  "profile:write": { description: "Update display name and avatar.", delegable: true },
  "tokens:manage": { description: "Create, list, and revoke API tokens.", delegable: false },
  "billing:read": {
    description: "Read credit, usage, membership, and model information.",
    delegable: true,
  },
  "billing:purchase": { description: "Create and inspect purchase orders.", delegable: true },
  "projects:read": { description: "List and read projects.", delegable: true },
  "projects:write": { description: "Create and update projects.", delegable: true },
  "projects:lifecycle": { description: "Archive, trash, and restore projects.", delegable: true },
  "projects:delete": { description: "Permanently delete trashed projects.", delegable: true },
  "documents:read": { description: "List and read documents.", delegable: true },
  "documents:write": { description: "Create and save documents.", delegable: true },
  "documents:export": { description: "Export documents.", delegable: true },
  "documents:delete": { description: "Delete documents and associated indexes.", delegable: true },
  "sessions:read": { description: "List and read Sessions and their processing state.", delegable: true },
  "sessions:write": { description: "Create, open, rename, archive, and restore Sessions.", delegable: true },
  "sessions:delete": { description: "Strong-delete Sessions and their project memory.", delegable: true },
  "agents:run": { description: "Send instructions to the Chief Editor and consume credits.", delegable: true },
  "skills:read": { description: "List Skills, drafts, and workspace enablement.", delegable: true },
  "skills:write": { description: "Create, review, confirm, and discard Skill drafts.", delegable: true },
  "skills:manage": { description: "Manage workspace Skills and eligible user Skills.", delegable: true },
};

export type ScopePreset = "read" | "write" | "agent:run";

const PRESET_SCOPES: Record<ScopePreset, readonly ApiScope[]> = {
  read: ["projects:read", "documents:read", "sessions:read", "skills:read", "billing:read"],
  write: ["documents:write", "documents:export", "sessions:write"],
  "agent:run": ["agents:run"],
};

export function expandScopePresets(presets: readonly ScopePreset[]): ApiScope[] {
  const scopes = presets
    .flatMap((preset) => PRESET_SCOPES[preset])
    .filter((scope) => API_SCOPES[scope].delegable);
  return [...new Set(scopes)];
}

export function hasScopes(granted: ReadonlySet<ApiScope>, required: readonly ApiScope[]): boolean {
  return required.every((scope) => granted.has(scope));
}
