/**
 * Skills management library.
 *
 * Skills follow the Agent Skills standard (agentskills.io).
 * Each skill is a SKILL.md file stored in InsForge Storage.
 * The skill_registry table tracks globally installed skills.
 * The workspace_skills table tracks per-workspace enable/disable state.
 *
 * Two-tier skill model (mirrors open-design pattern):
 *   - built-in: shipped with the app, user_id IS NULL, source='built-in' (cannot uninstall)
 *   - user: installed by a specific user, user_id is set, source='user'
 *
 * User Skills enter through the reviewed draft and confirmation service.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DbClient } from "./db.js";
import type { ContentStore } from "./content-store.js";
import { createContentStore } from "./content-store-factory.js";
import { parseFrontmatter } from "./frontmatter.js";
import { createHash } from "node:crypto";
import { checkCapabilityCompatibility } from "../skills/capabilities.js";
import { SKILL_POLICY_VERSION, type SkillRole } from "../skills/policy.js";
import { createLogger } from "./logger.js";
import { BUILTIN_SKILLS, BUILTIN_SKILL_KEYS } from "./agent-resources/catalog.js";
import { getAgentResourceService } from "./agent-resources/runtime.js";
import { validateBuiltInSkillContent } from "./agent-resources/service.js";

export { BUILTIN_SKILLS } from "./agent-resources/catalog.js";

const log = createLogger("skills");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ────────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

export interface LoadedSkill {
  slug: string;
  metadata: {
    name: string;
    description: string;
    globs?: string[];
    alwaysAllow?: string[];
    icon?: string;
    requiredSources?: string[];
    mode?: string;
  };
  content: string;
  path: string;
  source: "built-in" | "user";
}

export interface SkillRegistryEntry {
  id: string;
  slug: string;
  name: string;
  description?: string;
  storage_path: string;
  version: string;
  user_id?: string | null;
  source: string;
  metadata?: Record<string, unknown> | null;
  review_status?: "approved" | "review_required" | "quarantined" | null;
  review_policy_version?: string | null;
  approved_content_hash?: string | null;
  created_at: string;
}

export interface WorkspaceSkillEntry {
  workspace_id: string;
  skill_slug: string;
  enabled: boolean;
  created_at: string;
}

// ─── Globals ────────────────────────────────────────────────────────

function getDb(token?: string): DbClient {
  if (!token) throw new Error("User access token is required");
  return DbClient.forUser(token);
}

function getStorage(token: string): ContentStore {
  return createContentStore({ mode: "user", token, bucket: "skills" });
}

/**
 * Compute the storage object path for a USER skill, namespaced by owner:
 * users/{userId}/{slug}/SKILL.md. Storage READ isolation is enforced by RLS
 * (uploaded_by = sub); the owner prefix exists so two users with the same
 * slug don't collide on the same storage object key.
 *
 * Built-in skills use the separate private `agent-resources` bucket through
 * the trusted system client. This helper remains specific to USER skills.
 */
export function skillFilePath(slug: string, source: string, userId?: string | null): string {
  const prefix = source === "built-in" ? "builtin/" : `users/${userId ?? ""}/`;
  return `${prefix}${slug}/SKILL.md`;
}

/** Absolute path to a built-in skill's bundled SKILL.md on disk. */
function builtInSkillPath(slug: string): string {
  return path.resolve(__dirname, "..", "builtin", slug, "SKILL.md");
}

/**
 * Read a built-in skill's SKILL.md from the bundled file on disk.
 * Returns { content, frontmatter, body } or null if the file is missing.
 */
export function readBuiltInSkillContent(slug: string): {
  content: string; frontmatter: Record<string, unknown>; body: string;
} | null {
  let raw: string;
  try {
    raw = fs.readFileSync(builtInSkillPath(slug), "utf-8");
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  return { content: raw, frontmatter, body };
}

export async function loadBuiltInSkillContent(slug: string): Promise<{
  content: string; frontmatter: Record<string, unknown>; body: string;
} | null> {
  if (!BUILTIN_SKILL_KEYS.has(slug)) return null;
  const loaded = await getAgentResourceService().load({
    type: "builtin_skill", key: slug,
    fallback: () => readBuiltInSkillContent(slug)?.content ?? null,
  });
  if (validateBuiltInSkillContent(slug, loaded.content).length) return null;
  const { frontmatter, body } = parseFrontmatter(loaded.content);
  return { content: loaded.content, frontmatter, body };
}

// ─── Skill registry ──────────────────────────────────────────────────

export async function listInstalledSkills(
  token?: string,
  userId?: string,
): Promise<SkillRegistryEntry[]> {
  const db = getDb(token);
  return db.listSkillRegistry(userId);
}

export async function getSkillFromRegistry(
  slug: string,
  token?: string,
): Promise<SkillRegistryEntry | null> {
  const db = getDb(token);
  return db.getSkillFromRegistry(slug);
}

export async function uninstallSkill(
  token: string,
  slug: string,
  userId?: string,
): Promise<void> {
  if (!userId) {
    throw new Error("userId is required to uninstall a skill");
  }

  const db = getDb(token);
  const storage = getStorage(token);

  // Resolve the user's row (also rejects built-ins, which return source=built-in)
  const entry = await db.getSkillForUser(slug, userId);
  if (!entry) {
    throw new Error(`Skill not found: ${slug}`);
  }
  if (entry.source === "built-in") {
    throw new Error("Cannot uninstall built-in skills");
  }

  // Remove from storage (namespaced by owner)
  const filePath = skillFilePath(slug, "user", userId);
  try { await storage.delete(filePath); } catch { /* ignore */ }
  try { await storage.delete(`users/${userId}/${slug}/`); } catch { /* ignore */ }

  // Remove from registry (scoped to user)
  await db.uninstallSkill(slug, userId);

  // Note: workspace_skills references will need manual cleanup or ON DELETE CASCADE.
  // For now, dangling references are harmless — toggleWorkspaceSkill already
  // validates against the registry before enabling.
}

// ─── Workspace skill toggle ─────────────────────────────────────────

export async function getWorkspaceSkills(
  token: string,
  workspaceId: string,
  userId?: string,
): Promise<Array<SkillRegistryEntry & { enabled: boolean }>> {
  const db = getDb(token);

  // Only this user's skills + built-ins — never other tenants'.
  const registry = await db.listSkillRegistry(userId);
  const wsSkills = await db.listWorkspaceSkills(workspaceId);
  const wsMap = new Map(wsSkills.map((w: any) => [w.skill_slug, w.enabled]));

  return registry
    .filter((entry: SkillRegistryEntry) => entry.source === "built-in" || entry.review_status === "approved")
    .map((r: SkillRegistryEntry) => ({
    ...r,
    enabled: wsMap.get(r.slug) ?? false,
    }));
}

export async function toggleWorkspaceSkill(
  token: string,
  workspaceId: string,
  skillSlug: string,
  enabled: boolean,
  userId?: string,
): Promise<void> {
  const db = getDb(token);

  // Verify the skill belongs to this user or is built-in before toggling.
  const skill = await db.getSkillForUser(skillSlug, userId);
  if (!skill) throw new Error(`Skill not found: ${skillSlug}`);
  if (enabled && skill.source !== "built-in" && skill.review_status !== "approved") {
    throw new Error(`Skill is not approved: ${skillSlug}`);
  }

  await db.toggleWorkspaceSkill(workspaceId, skillSlug, enabled);
}

// ─── Load skills for Agent ──────────────────────────────────────────

export async function loadEnabledSkills(
  token: string,
  workspaceId: string,
  userId?: string,
  role: SkillRole = "chief_editor",
): Promise<Skill[]> {
  const db = getDb(token);

  const wsSkills = await db.listWorkspaceSkills(workspaceId);
  const enabledSlugs = wsSkills
    .filter((w: any) => w.enabled)
    .map((w: any) => w.skill_slug);

  const skills: Skill[] = [];

  for (const slug of enabledSlugs) {
    // Resolve scoped to this user (built-in wins on collision).
    const registry = await db.getSkillForUser(slug, userId);
    if (!registry) continue;

    if (registry.source !== "built-in") {
      if (registry.review_status !== "approved" || registry.review_policy_version !== SKILL_POLICY_VERSION) continue;
      const roles = await db.listSkillRoles(registry.id);
      if (!roles.includes(role)) continue;
      const required = Array.isArray(registry.metadata?.requiredCapabilities)
        ? registry.metadata.requiredCapabilities.filter((item: unknown): item is string => typeof item === "string")
        : [];
      if (!checkCapabilityCompatibility(role, required).ok) continue;
    } else if (slug === "skill-creator" && role !== "chief_editor") {
      continue;
    }

    let frontmatter: Record<string, unknown>;
    let body: string;
    let skillRoot: string;

    if (registry.source === "built-in") {
      // Built-ins are shipped files on disk (storage is per-owner only).
      const file = await loadBuiltInSkillContent(slug);
      if (!file) continue;
      frontmatter = file.frontmatter;
      body = file.body;
      skillRoot = `builtin/${slug}`;
    } else {
      const storage = getStorage(token);
      let content: string;
      try {
        content = await storage.read(skillFilePath(slug, "user", registry.user_id));
      } catch {
        continue;
      }
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      if (!registry.approved_content_hash || registry.approved_content_hash !== contentHash) continue;
      ({ frontmatter, body } = parseFrontmatter(content));
      skillRoot = `users/${registry.user_id ?? userId ?? ""}/${slug}`;
    }

    skills.push({
      name: (frontmatter.name as string) ?? registry.name,
      description: (frontmatter.description as string) ?? registry.description ?? "",
      content: body,
      filePath: `${skillRoot}/SKILL.md`,
      baseDir: skillRoot,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    });
  }

  return skills;
}

/**
 * Render the spec-compatible `<available_skills>` block for agent system prompts.
 * Vendored from pi-agent-core's harness layer (removed in pi 1.0); the XML shape
 * is a format contract with `load_skill` tooling and must not drift.
 */
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── UI skill projection ────────────────────────────────────────────

/**
 * List all skills for the Settings page.
 * Merges built-in skills (user_id IS NULL) + user-installed skills for the given user.
 * Built-in skills win on slug collision.
 */
export async function listAllSkillsForUI(
  token: string,
  userId?: string,
): Promise<LoadedSkill[]> {
  const registry = await listInstalledSkills(token, userId);

  // Dedupe: built-in wins on slug collision
  const seen = new Map<string, SkillRegistryEntry>();
  // Sort so built-in entries come first
  const sorted = [...registry].sort((a, b) => {
    if (a.source === "built-in" && b.source !== "built-in") return -1;
    if (a.source !== "built-in" && b.source === "built-in") return 1;
    return 0;
  });
  for (const s of sorted) {
    if (!seen.has(s.slug)) seen.set(s.slug, s);
  }

  return Array.from(seen.values()).map((s) => ({
    slug: s.slug,
    metadata: {
      name: s.name,
      description: s.description ?? "",
      ...(s.metadata && typeof s.metadata === "object" ? (s.metadata as Record<string, unknown>) : {}),
    } as LoadedSkill["metadata"],
    content: "",
    path: `skills/${s.slug}`,
    source: (s.source === "built-in" ? "built-in" : "user") as LoadedSkill["source"],
  }));
}

export async function loadSkillsForUI(
  token: string,
  workspaceId: string,
): Promise<LoadedSkill[]> {
  const workspaceSkills = await getWorkspaceSkills(token, workspaceId);

  return workspaceSkills
    .filter((s) => s.enabled)
    .map((s) => ({
      slug: s.slug,
      metadata: {
        name: s.name,
        description: s.description ?? "",
        ...(s.metadata && typeof s.metadata === "object" ? (s.metadata as Record<string, unknown>) : {}),
      } as LoadedSkill["metadata"],
      content: "",
      path: `skills/${s.slug}`,
      source: (s.source === "built-in" ? "built-in" : "user") as LoadedSkill["source"],
    }));
}

export async function loadSkillForUI(
  token: string,
  slug: string,
  userId?: string,
): Promise<LoadedSkill | null> {
  const db = getDb(token);

  const registry = await db.getSkillForUser(slug, userId);
  if (!registry) return null;

  let frontmatter: Record<string, unknown>;
  let body: string;
  let skillRoot: string;

  if (registry.source === "built-in") {
    const file = await loadBuiltInSkillContent(slug);
    if (!file) return null;
    frontmatter = file.frontmatter;
    body = file.body;
    skillRoot = `builtin/${slug}`;
  } else {
    const storage = getStorage(token);
    let content: string;
    try {
      content = await storage.read(skillFilePath(slug, "user", registry.user_id));
    } catch {
      return null;
    }
    ({ frontmatter, body } = parseFrontmatter(content));
    skillRoot = `users/${registry.user_id ?? userId ?? ""}/${slug}`;
  }

  return {
    slug,
    metadata: {
      name: (frontmatter.name as string) ?? registry.name,
      description: (frontmatter.description as string) ?? registry.description ?? "",
    },
    content: body,
    path: `${skillRoot}/SKILL.md`,
    source: (registry.source === "built-in" ? "built-in" : "user") as LoadedSkill["source"],
  };
}

export async function listSkillFiles(
  token: string,
  slug: string,
  userId?: string,
): Promise<Array<{ name: string; type: "file" | "directory"; size?: number; children?: any[] }>> {
  const db = getDb(token);
  const registry = await db.getSkillForUser(slug, userId);
  if (!registry) return [];

  let skillMdSize = 0;
  try {
    let content: string;
    if (registry.source === "built-in") {
      const file = await loadBuiltInSkillContent(slug);
      if (!file) return [];
      content = file.content;
    } else {
      const storage = getStorage(token);
      content = await storage.read(skillFilePath(slug, "user", registry.user_id));
    }
    skillMdSize = Buffer.byteLength(content, "utf-8");
  } catch {
    return [];
  }

  return [
    { name: "SKILL.md", type: "file", size: skillMdSize },
  ];
}

// ─── Bulk operations ────────────────────────────────────────────────

export async function enableDefaultSkillsForWorkspace(
  token: string,
  workspaceId: string,
  slugs: string[],
): Promise<void> {
  const db = getDb(token);
  for (const slug of slugs) {
    const existing = await db.getSkillFromRegistry(slug);
    if (existing) {
      await db.toggleWorkspaceSkill(workspaceId, slug, true);
    }
  }
}

// ─── Built-in skill installation ─────────────────────────────────────

/**
 * Register built-in skills into the skill registry.
 * Runs on startup — registers skills missing from the registry. Built-in
 * skills have source="built-in" and user_id=null. Their active content comes
 * from the verified platform resource service; this function persists only
 * the catalog metadata used by workspace enablement.
 */
export async function installBuiltInSkills(_token: string): Promise<string[]> {
  const db = DbClient.forSystem();
  const installed: string[] = [];

  for (const builtin of BUILTIN_SKILLS) {
    const file = await loadBuiltInSkillContent(builtin.slug);
    if (!file) {
      log.warn(`Built-in skill source not found: builtin/${builtin.slug}/SKILL.md`);
      continue;
    }

    // Register in the DB only if missing.
    const existing = await db.getSkillFromRegistry(builtin.slug);
    if (existing) continue;

    const name = (file.frontmatter.name as string) ?? builtin.slug;
    const description = (file.frontmatter.description as string) ?? "";

    await db.installSkill({
      slug: builtin.slug,
      name,
      description,
      storagePath: `builtin/${builtin.slug}`,
      source: "built-in",
    });

    installed.push(builtin.slug);
    log.info(`Installed built-in skill: ${builtin.slug}`);
  }

  return installed;
}
