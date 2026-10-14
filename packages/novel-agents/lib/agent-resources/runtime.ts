import { DbClient } from "../db.js";
import { createContentStore } from "../content-store-factory.js";
import { PostgrestAgentResourceRepository } from "./repository.js";
import { AgentResourceService } from "./service.js";

let singleton: AgentResourceService | undefined;

export function getAgentResourceService(): AgentResourceService {
  if (singleton) return singleton;
  const db = DbClient.forSystem();
  singleton = new AgentResourceService({
    repository: new PostgrestAgentResourceRepository(db),
    storage: createContentStore({ mode: "system", token: db.storageToken, bucket: "agent-resources" }),
    metadataTtlMs: 30_000,
    fallbackEnabled: process.env.AGENT_RESOURCE_FALLBACK_ENABLED === "true",
  });
  return singleton;
}

export function resetAgentResourceServiceForTests(): void { singleton = undefined; }
