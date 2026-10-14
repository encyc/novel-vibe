import type { Message } from "@earendil-works/pi-ai";
import {
  getSystemModelHealthService,
  getSystemModelResolver,
} from "../model-runtime/system-resolver.js";
import {
  isSupportedLanguage,
  normalizeSupportedLanguage,
  type SupportedLanguage,
} from "../lib/language.js";
import { ApiTokenRepository } from "../auth/api-token-repository.js";
import { ApiTokenService, type ApiTokenLifetimeDays } from "../auth/api-token-service.js";
import { RegistrationRepository } from "../registration/repository.js";
import { RegistrationService } from "../registration/service.js";
import { ReferralRepository } from "../referral/repository.js";
import { ReferralService } from "../referral/service.js";
import { ContextManager } from "../context/manager.js";
import { CreditBillingClient } from "../lib/credits.js";
import { createEntitlementPort } from "../billing/entitlement-adapter.js";
import { MembershipService } from "../billing/membership-service.js";
import { DbClient } from "../lib/db.js";
import { isLocalMode } from "../lib/local-mode.js";
import {
  ALLOW_ALL_ENTITLEMENTS,
  LOCAL_TURN_USAGE_BILLING,
} from "../lib/policy-ports.js";
import type { ByokTurnState } from "../lib/byok.js";
import type { CompactionBilling } from "../context/types.js";
import { NovelOrchestrator } from "../agents.js";
import { ProjectRepository } from "../project/repository.js";
import { ProjectService } from "../project/service.js";
import { SessionRepository } from "../session/repository.js";
import { SessionService, SessionTurnInterruptedError } from "../session/service.js";
import { createContentStore } from "../lib/content-store-factory.js";
import { UserRuntimeRegistry } from "../session/runtime-registry.js";
import { complete } from "@earendil-works/pi-ai/compat";
import { createProjectMemoryAdapter } from "../memori.js";
import { loadAgentPrompt } from "../lib/agent-resources/loader.js";
import { resolve, dirname } from "node:path";

export interface UserSessionRuntime {
  db: DbClient;
  repository: SessionRepository;
  service: SessionService;
}

export interface SystemSessionRuntime {
  db: DbClient;
  repository: SessionRepository;
}

export const userSessionRuntimes = new UserRuntimeRegistry<UserSessionRuntime>(
  (token) => createSessionRuntime(token),
  { maxEntries: 1_000 },
);

let systemSessionRuntime: SystemSessionRuntime | null = null;

function allAgentOverrides(provider?: string, model?: string) {
  if (!provider && !model) return undefined;
  const override = {
    provider: provider ?? process.env.LLM_PROVIDER ?? "deepseek",
    model: model ?? process.env.LLM_MODEL ?? "deepseek-v4-flash",
  };
  return Object.fromEntries([
    "chief_editor",
    "worldbuilder",
    "character_designer",
    "outliner",
    "director",
    "writer",
    "script_supervisor",
  ].map((id) => [id, override]));
}

export function getSystemSessionRuntime(): SystemSessionRuntime {
  if (systemSessionRuntime) return systemSessionRuntime;
  const db = DbClient.forSystem();
  const repository = new SessionRepository(db);
  systemSessionRuntime = { db, repository };
  return systemSessionRuntime;
}

function createSessionRuntime(token: string): UserSessionRuntime {
  const db = DbClient.forUser(token);
  const repository = new SessionRepository(db);
  const system = getSystemSessionRuntime();
  const billing = new CreditBillingClient(system.db);

  // Composition root: pick the implementations here and hand them to the creation
  // core as ports. The core (agents/tools/routes) must not import them.
  //
  // Local-first mode has nothing to buy: the user owns the install and their own
  // model key pays the provider, so every entitlement is held and nothing is
  // billed. See docs/adr/0006-policy-ports.md and lib/local-mode.ts.
  const localMode = isLocalMode();
  const turnBilling = localMode
    ? LOCAL_TURN_USAGE_BILLING
    : new CreditBillingClient(system.db);
  const entitlements = localMode
    ? ALLOW_ALL_ENTITLEMENTS
    : createEntitlementPort(
      (userId) => new MembershipService(system.db).getStatus(userId),
    );

  const createContextManager = (
    projectId: string,
    userId: string | undefined,
    creativeLanguage: SupportedLanguage,
    byokTurnState: ByokTurnState,
  ) => {
    // Summary generation resolves the model through the system resolver (the
    // byok- base provider shares the builtin catalog) and pays with the
    // user's own key whenever the enclosing turn carries one.
    const summaryGenerator = async ({ model, prompt, messages }: {
      model: import("../session/types.js").ModelDescriptor;
      prompt: string;
      messages: import("@earendil-works/pi-agent-core").AgentMessage[];
    }) => {
      const resolved = await getSystemModelResolver().resolve(model.provider, model.model);
      const requestOptions = byokTurnState.apiKey
        ? { apiKey: byokTurnState.apiKey }
        : undefined;
      let response;
      try {
        response = await complete(resolved.model, {
          systemPrompt: prompt,
          messages: messages.filter((message): message is Message =>
            message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
        }, requestOptions);
      } catch (error) {
        await getSystemModelHealthService().observeFailure(resolved, error);
        throw error;
      }
      if (response.stopReason === "error") {
        await getSystemModelHealthService().observeFailure(
          resolved,
          new Error(response.errorMessage ?? "Summary model request failed"),
        );
      }
      const summary = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      return { summary, usage: response.usage };
    };
    // BYOK compaction records an audit row without touching platform credits.
    const compactionBilling: CompactionBilling = {
      createPricingQuote: (params) => billing.createPricingQuote(params),
      recordCompactionUsage: (params) => byokTurnState.apiKey
        ? billing.recordByokUsage({
            userId: params.userId,
            projectId: params.projectId,
            sessionId: params.sessionId,
            agentId: "session_compaction",
            modelId: params.modelId,
            modelProvider: params.modelProvider,
            usage: params.usage,
          })
        : billing.recordCompactionUsage(params),
    };
    return new ContextManager({
      token,
      projectId,
      userId,
      creativeLanguage,
      repository,
      promptLoader: loadAgentPrompt,
      skillLoader: async (tok, pid, uid, agentId) => {
        const { loadEnabledSkills, formatSkillsForSystemPrompt } = await import("../lib/skills.js");
        const skills = await loadEnabledSkills(tok, pid, uid, agentId);
        return skills.length > 0 ? formatSkillsForSystemPrompt(skills) : "";
      },
      instructionLoader: async (tok, pid, _uid, agentId) => {
        const { parseLingqi, filterForAgent } = await import("../lib/lingqi.js");
        const storage = createContentStore({ mode: "user", token: tok, bucket: "novels", projectId: pid });
        try {
          const content = await storage.read("LINGQI.md");
          return filterForAgent(parseLingqi(content), agentId);
        } catch {
          // No LINGQI.md for this project — silently no-op.
          return "";
        }
      },
      modelDescriptors: {},
      summaryGenerator,
      billing: compactionBilling,
    });
  };
  const service = new SessionService({
    repository,
    createOrchestrator: async ({
      token,
      projectId,
      userId,
      sessionId,
      provider,
      model,
      creativeLanguage,
    }) => {
      const byokTurnState: ByokTurnState = { apiKey: null };
      const contextManager = createContextManager(projectId, userId, creativeLanguage, byokTurnState);
      const orchestrator = new NovelOrchestrator({
        token,
        projectId,
        billing: turnBilling,
        entitlements,
        userId,
        sessionId,
        modelOverrides: allAgentOverrides(provider, model),
        byokTurnState,
        contextManager,
        creativeLanguage,
      });
      return orchestrator;
    },
    createMemory: ({ userId, projectId, sessionId }) => {
      if (!process.env.MEMORI_API_KEY) return null;
      return createProjectMemoryAdapter(userId, projectId, sessionId, repository);
    },
  });
  return { db, repository, service };
}

export function getSessionRuntime(userId: string, token: string): UserSessionRuntime {
  return userSessionRuntimes.get(userId, token);
}

export function createProjectService(token: string): ProjectService {
  const userDb = DbClient.forUser(token);
  const systemDb = getSystemSessionRuntime().db;
  return new ProjectService(new ProjectRepository(userDb, systemDb));
}

export function createApiTokenService(): ApiTokenService {
  return new ApiTokenService(new ApiTokenRepository(DbClient.forSystem()));
}

export function createRegistrationService(): RegistrationService {
  return new RegistrationService(new RegistrationRepository(DbClient.forSystem()));
}

export function createReferralService(): ReferralService {
  return new ReferralService(
    new ReferralRepository(DbClient.forSystem()),
    process.env.PUBLIC_APP_ORIGIN?.trim() || "https://app.lingqiai.art",
  );
}
