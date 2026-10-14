import type { AgentId } from "../../session/types.js";
import { PROMPT_RESOURCE_KEYS, readPackagedPrompt } from "./catalog.js";
import { getAgentResourceService } from "./runtime.js";

export async function loadAgentPrompt(agentId: AgentId): Promise<string> {
  return (await getAgentResourceService().load({
    type: "prompt",
    key: PROMPT_RESOURCE_KEYS[agentId],
    fallback: () => readPackagedPrompt(agentId),
  })).content;
}
