import { createHash } from "node:crypto";
import { SKILL_ROLES, validateSkill } from "../../skills/policy.js";
import { BUILTIN_SKILL_KEYS } from "./catalog.js";
import type {
  AgentResourceRepository, AgentResourceType, AgentResourceVersion,
} from "./types.js";

const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STRUCTURAL_SKILL_ISSUES = new Set([
  "INVALID_FILENAME", "CONTENT_TOO_LARGE", "INVALID_SLUG", "MISSING_ROLE", "INVALID_ROLE",
  "MISSING_FRONTMATTER", "UNSUPPORTED_FRONTMATTER_FIELD", "MISSING_NAME", "MISSING_DESCRIPTION", "EMPTY_BODY",
]);

export function validateBuiltInSkillContent(slug: string, content: string): string[] {
  const result = validateSkill({ filename: "SKILL.md", slug, content, roles: [...SKILL_ROLES] });
  return result.issues.filter((issue) => STRUCTURAL_SKILL_ISSUES.has(issue.code)).map((issue) => issue.code);
}

export interface AgentResourceIdentity { type: AgentResourceType; key: string }
export interface AgentResourceHealth {
  status: "healthy" | "degraded";
  degraded: Array<AgentResourceIdentity & { reason: string }>;
}
export interface LoadedAgentResource extends AgentResourceIdentity {
  content: string;
  source: "remote" | "stale_cache" | "fallback";
  versionId: string | null;
  versionNumber: number | null;
  contentHash: string;
}

interface ResourceStorage {
  read(path: string): Promise<string>;
  writeImmutable(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}

class AgentResourceContentError extends Error {}
const digest = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
const identityKey = (type: AgentResourceType, key: string) => `${type}:${key}`;

export class AgentResourceService {
  private readonly metadata = new Map<string, { active: Awaited<ReturnType<AgentResourceRepository["resolveActive"]>>; expiresAt: number }>();
  private readonly content = new Map<string, string>();
  private readonly lastVerified = new Map<string, LoadedAgentResource>();
  private readonly degraded = new Map<string, AgentResourceIdentity & { reason: string }>();
  private readonly now: () => number;

  constructor(private readonly options: {
    repository: AgentResourceRepository;
    storage: ResourceStorage;
    fallbackEnabled: boolean;
    metadataTtlMs: number;
    now?: () => number;
  }) { this.now = options.now ?? Date.now; }

  async load(input: AgentResourceIdentity & { fallback?: () => string | null }): Promise<LoadedAgentResource> {
    return this.loadInternal(input, true);
  }

  private async loadInternal(
    input: AgentResourceIdentity & { fallback?: () => string | null }, allowFallback: boolean,
  ): Promise<LoadedAgentResource> {
    const cacheKey = identityKey(input.type, input.key);
    try {
      let cached = this.metadata.get(cacheKey);
      if (!cached || cached.expiresAt <= this.now()) {
        const active = await this.options.repository.resolveActive(input.type, input.key);
        cached = { active, expiresAt: this.now() + this.options.metadataTtlMs };
        this.metadata.set(cacheKey, cached);
      }
      if (!cached.active) throw new AgentResourceContentError(`agent resource not found: ${cacheKey}`);
      const { version } = cached.active;
      let body = this.content.get(version.id);
      if (body === undefined) {
        body = await this.options.storage.read(version.storagePath);
        const actual = digest(body);
        if (actual !== version.contentHash) {
          throw new AgentResourceContentError(`content hash mismatch for ${cacheKey}`);
        }
        this.content.set(version.id, body);
      }
      const result: LoadedAgentResource = {
        ...input, content: body, source: "remote", versionId: version.id,
        versionNumber: version.versionNumber, contentHash: version.contentHash,
      };
      this.lastVerified.set(cacheKey, result);
      this.degraded.delete(cacheKey);
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.degraded.set(cacheKey, { type: input.type, key: input.key, reason });
      const stale = this.lastVerified.get(cacheKey);
      if (stale && !(error instanceof AgentResourceContentError)) {
        return { ...stale, source: "stale_cache" };
      }
      if (allowFallback && this.options.fallbackEnabled && input.fallback) {
        const fallback = input.fallback();
        if (fallback?.trim()) {
          return {
            ...input, content: fallback, source: "fallback", versionId: null,
            versionNumber: null, contentHash: digest(fallback),
          };
        }
      }
      throw error;
    }
  }

  async publish(input: AgentResourceIdentity & { content: string; changeNote?: string }): Promise<AgentResourceVersion> {
    if (!KEY_RE.test(input.key)) throw new Error("invalid agent resource key");
    if (!input.content.trim()) throw new Error("agent resource content must not be empty");
    if (input.type === "prompt" && Buffer.byteLength(input.content, "utf8") > 256 * 1024) {
      throw new Error("Prompt exceeds 256 KiB");
    }
    if (input.type === "builtin_skill") {
      if (!BUILTIN_SKILL_KEYS.has(input.key)) throw new Error(`built-in Skill is not allowlisted: ${input.key}`);
      const issues = validateBuiltInSkillContent(input.key, input.content);
      if (issues.length) throw new Error(`invalid built-in Skill: ${issues.join(", ")}`);
    }
    const versionNumber = await this.options.repository.nextVersionNumber(input.type, input.key);
    const contentHash = digest(input.content);
    const storagePath = input.type === "prompt"
      ? `prompts/${input.key}/v${versionNumber}-${contentHash}.md`
      : `skills/${input.key}/v${versionNumber}-${contentHash}/SKILL.md`;
    await this.options.storage.writeImmutable(storagePath, input.content);
    try {
      const result = await this.options.repository.publishVersion({
        resourceType: input.type, resourceKey: input.key, versionNumber,
        storagePath, contentHash, changeNote: input.changeNote,
      });
      this.invalidate(input.type, input.key);
      return result;
    } catch (error) {
      try {
        const active = await this.options.repository.resolveActive(input.type, input.key);
        if (active?.version.storagePath !== storagePath) await this.options.storage.delete(storagePath);
      } catch { /* best-effort cleanup */ }
      throw error;
    }
  }

  async rollback(type: AgentResourceType, key: string, versionNumber: number): Promise<AgentResourceVersion> {
    if (!Number.isInteger(versionNumber) || versionNumber <= 0) throw new Error("version must be a positive integer");
    const result = await this.options.repository.activateVersion(type, key, versionNumber);
    this.invalidate(type, key);
    return result;
  }

  async verifyRequired(required: readonly AgentResourceIdentity[]): Promise<AgentResourceHealth> {
    await Promise.all(required.map(async (item) => {
      this.invalidate(item.type, item.key);
      try { await this.loadInternal(item, false); } catch { /* health retains reason */ }
    }));
    return this.health();
  }

  health(): AgentResourceHealth {
    const degraded = [...this.degraded.values()];
    return { status: degraded.length ? "degraded" : "healthy", degraded };
  }

  invalidate(type: AgentResourceType, key: string): void {
    this.metadata.delete(identityKey(type, key));
  }
}
