import type { SkillRole } from "./policy.js";

const ALL_ROLES: readonly SkillRole[] = [
  "chief_editor", "worldbuilder", "character_designer", "outliner", "director", "writer", "script_supervisor",
];
const SUB_AGENT_ROLES: readonly SkillRole[] = [
  "worldbuilder", "character_designer", "outliner", "director", "writer", "script_supervisor",
];

export interface PlatformCapability {
  id: string;
  toolName: string;
  roles: readonly SkillRole[];
}

export const CAPABILITY_CATALOG: readonly PlatformCapability[] = [
  { id: "documents.read", toolName: "read_doc", roles: ALL_ROLES },
  { id: "skills.list", toolName: "list_skills", roles: ALL_ROLES },
  { id: "skills.load", toolName: "load_skill", roles: ALL_ROLES },
  { id: "documents.write", toolName: "write_doc", roles: ALL_ROLES },
  { id: "documents.delete", toolName: "delete_doc", roles: ["chief_editor"] },
  { id: "documents.request_delete", toolName: "delete_doc", roles: SUB_AGENT_ROLES },
  { id: "documents.search", toolName: "search_docs", roles: ALL_ROLES },
  { id: "documents.list", toolName: "list_docs", roles: ALL_ROLES },
  { id: "documents.chapter_context", toolName: "chapter_context", roles: ALL_ROLES },
  { id: "documents.lint", toolName: "lint_doc", roles: ["director", "writer", "script_supervisor"] },
  { id: "documents.notes_health", toolName: "notes_health", roles: ["chief_editor", "script_supervisor"] },
  { id: "references.query", toolName: "query_references", roles: ALL_ROLES },
  { id: "references.foreshadow_debt", toolName: "foreshadow_debt", roles: ALL_ROLES },
  { id: "references.list_variants", toolName: "list_variants", roles: ALL_ROLES },
  { id: "documents.variant_promote", toolName: "promote_variant", roles: ["chief_editor"] },
  { id: "simulator.reader", toolName: "simulate_reader", roles: ["chief_editor"] },
  { id: "indexes.sync", toolName: "sync_index", roles: ALL_ROLES },
  { id: "indexes.sync_all", toolName: "sync_all_indexes", roles: ALL_ROLES },
  { id: "project.status.update", toolName: "update_status", roles: ["chief_editor"] },
  { id: "project.status.read", toolName: "get_project_status", roles: ["chief_editor"] },
  { id: "agents.delegate", toolName: "delegate_to_agent", roles: ["chief_editor"] },
  { id: "skills.create_draft", toolName: "create_skill_draft", roles: ["chief_editor"] },
  { id: "skills.evolve", toolName: "propose_skill_evolution", roles: ["chief_editor"] },
  { id: "web.search", toolName: "web_search", roles: ["chief_editor"] },
  { id: "web.fetch", toolName: "web_fetch", roles: ["chief_editor"] },
  { id: "chat.run_plan.update", toolName: "update_run_plan", roles: ["chief_editor"] },
  { id: "chat.interaction.request", toolName: "request_user_interaction", roles: ["chief_editor"] },
] as const;

const capabilityById = new Map(CAPABILITY_CATALOG.map((entry) => [entry.id, entry]));

export function capabilityForTool(toolName: string): PlatformCapability | undefined {
  return CAPABILITY_CATALOG.find((entry) => entry.toolName === toolName);
}

export function capabilitiesForRole(role: SkillRole): ReadonlySet<string> {
  return new Set(
    CAPABILITY_CATALOG
      .filter((entry) => entry.roles.includes(role))
      .map((entry) => entry.id),
  );
}

export function checkCapabilityCompatibility(
  role: SkillRole,
  required: readonly string[],
): { ok: boolean; missing: string[] } {
  const available = capabilitiesForRole(role);
  const missing = [...new Set(required)].filter((id) => !capabilityById.has(id) || !available.has(id));
  return { ok: missing.length === 0, missing };
}
