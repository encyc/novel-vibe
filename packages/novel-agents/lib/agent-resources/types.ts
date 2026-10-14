export type AgentResourceType = "prompt" | "builtin_skill";

export interface AgentResourceVersion {
  id: string;
  resourceId: string;
  versionNumber: number;
  storagePath: string;
  contentHash: string;
  changeNote: string | null;
  createdAt: string;
}

export interface ActiveAgentResource {
  resourceId: string;
  type: AgentResourceType;
  key: string;
  version: AgentResourceVersion;
}

export interface PublishVersionInput {
  resourceType: AgentResourceType;
  resourceKey: string;
  versionNumber: number;
  storagePath: string;
  contentHash: string;
  changeNote?: string;
}

export interface AgentResourceRepository {
  resolveActive(type: AgentResourceType, key: string): Promise<ActiveAgentResource | null>;
  nextVersionNumber(type: AgentResourceType, key: string): Promise<number>;
  publishVersion(input: PublishVersionInput): Promise<AgentResourceVersion>;
  activateVersion(type: AgentResourceType, key: string, versionNumber: number): Promise<AgentResourceVersion>;
}
