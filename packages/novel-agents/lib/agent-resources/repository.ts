import type { DbClient } from "../db.js";
import type {
  ActiveAgentResource, AgentResourceRepository, AgentResourceType,
  AgentResourceVersion, PublishVersionInput,
} from "./types.js";

type ResourceDb = Pick<DbClient,
  "getActiveAgentResource" | "getNextAgentResourceVersion" |
  "publishAgentResourceVersion" | "activateAgentResourceVersion">;

function mapVersion(row: any): AgentResourceVersion {
  if (!row || typeof row.id !== "string" || typeof row.resource_id !== "string"
    || !Number.isInteger(row.version_number) || typeof row.storage_path !== "string"
    || typeof row.content_hash !== "string" || typeof row.created_at !== "string") {
    throw new Error("Malformed agent resource version row");
  }
  return {
    id: row.id, resourceId: row.resource_id, versionNumber: row.version_number,
    storagePath: row.storage_path, contentHash: row.content_hash,
    changeNote: typeof row.change_note === "string" ? row.change_note : null,
    createdAt: row.created_at,
  };
}

export class PostgrestAgentResourceRepository implements AgentResourceRepository {
  constructor(private readonly db: ResourceDb) {}

  async resolveActive(type: AgentResourceType, key: string): Promise<ActiveAgentResource | null> {
    const row = await this.db.getActiveAgentResource(type, key);
    if (!row) return null;
    if (typeof row.id !== "string" || row.resource_type !== type || row.resource_key !== key) {
      throw new Error("Malformed agent resource row");
    }
    if (!row.active_version) return null;
    return { resourceId: row.id, type, key, version: mapVersion(row.active_version) };
  }

  nextVersionNumber(type: AgentResourceType, key: string): Promise<number> {
    return this.db.getNextAgentResourceVersion(type, key);
  }

  async publishVersion(input: PublishVersionInput): Promise<AgentResourceVersion> {
    return mapVersion(await this.db.publishAgentResourceVersion(input));
  }

  async activateVersion(type: AgentResourceType, key: string, versionNumber: number): Promise<AgentResourceVersion> {
    return mapVersion(await this.db.activateAgentResourceVersion(type, key, versionNumber));
  }
}
