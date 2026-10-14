import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { NovelOrchestrator } from "./agents.js";
import { createChatTraceAdapter, type AgentId as TraceAgentId, type ChatStreamEvent } from "./lib/chat-trace.js";
import type { InteractionResponseV1 } from "./interactions/types.js";
import { createPersistedTracePersistence } from "./lib/persisted-chat-trace.js";
import { DbClient } from "./lib/db.js";
import {
  isSupportedLanguage,
  normalizeSupportedLanguage,
  type SupportedLanguage,
} from "./lib/language.js";
import { CreditBillingClient } from "./lib/credits.js";
import { ByokKeyService } from "./lib/byok-service.js";
import { countWords, parseFrontmatter } from "./lib/frontmatter.js";
import { sha256Content } from "./lib/storage.js";
import { documentWrites, documentWriteKey } from "./lib/document-write-coordinator.js";
import { DocumentVersionRepository } from "./document-version/repository.js";
import { DocumentConflictError, VersionedDocumentWriter } from "./document-version/service.js";
import { sliceDiffPage } from "./document-version/diff.js";
import { DocumentVersionRepairWorker, startDocumentVersionRepairWorker } from "./document-version/repair-worker.js";
import { createLogger } from "./lib/logger.js";
import { loadAgentPrompt } from "./lib/agent-resources/loader.js";
import { getAgentResourceService } from "./lib/agent-resources/runtime.js";
import { REQUIRED_AGENT_RESOURCES } from "./lib/agent-resources/catalog.js";
import { notifyIndexNow } from "./lib/indexnow.js";
import { submitBaiduUrls } from "./lib/baidu-submit.js";
import { deriveIdentity, mintDelegatedUserToken } from "./lib/auth.js";
import { LOCAL_IDENTITY, LOCAL_USER_ID, isLocalMode } from "./lib/local-mode.js";
import {
  ALLOW_ALL_ENTITLEMENTS,
  LOCAL_TURN_COST_POLICY,
} from "./lib/policy-ports.js";
import { SessionRepository } from "./session/repository.js";
import { SessionService, SessionTurnInterruptedError } from "./session/service.js";
import { UserRuntimeRegistry } from "./session/runtime-registry.js";
import { SessionDomainError } from "./session/types.js";
import { ContextManager } from "./context/manager.js";
import { createProjectMemoryAdapter } from "./memori.js";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import {
  getSystemModelHealthService,
  getSystemModelResolver,
} from "./model-runtime/system-resolver.js";
import { startMemoryJobWorker } from "./session/memory-adapter.js";
import { ProjectRepository } from "./project/repository.js";
import { ProjectDeletionRepository } from "./project/repository.js";
import { ProjectService } from "./project/service.js";
import { ProjectDomainError, type ProjectLifecycleStatus } from "./project/types.js";
import { ProjectDeletionWorker, startProjectDeletionWorker } from "./project/deletion-worker.js";
import { createContentStore } from "./lib/content-store-factory.js";
import { SkillServiceError } from "./skills/service.js";
import { buildSkillCreatorPrompt, parseChatCommand } from "./skills/creator-command.js";
import { buildLingqiPrompt } from "./skills/lingqi-command.js";
import { ProfileInputError, ProfileService } from "./billing/profile-service.js";
import { createEntitlementPort, createTurnCostPolicy } from "./billing/entitlement-adapter.js";
import { PaymentError, PaymentService } from "./billing/payment-service.js";
import { MembershipService } from "./billing/membership-service.js";
import { CommunityService, CommunityServiceError } from "./community/service.js";
import { RegistrationError } from "./registration/types.js";
import { ReferralError } from "./referral/types.js";
import { ApiTokenRepository } from "./auth/api-token-repository.js";
import { ApiTokenService, type ApiTokenLifetimeDays } from "./auth/api-token-service.js";
import { API_SCOPES, expandScopePresets, type ApiScope, type ScopePreset } from "./auth/scopes.js";
import { corsHeaders, errorResponse, extractToken, RequestBodyTooLargeError } from "./server/http.js";
import type { RouteContext } from "./server/http.js";
import { AUTH_ROUTES, PUBLIC_ROUTES } from "./server/router.js";
import { handleCommunityAnonReads } from "./server/routes/community.js";
import { userSessionRuntimes, getSystemSessionRuntime } from "./server/runtime.js";
import { ContinuityWorker, startContinuityWorker } from "./continuity/worker.js";
import { createSystemContinuityExecutor } from "./continuity/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, ".env") });

const PORT = parseInt(process.env.NOVEL_VIBE_PORT ?? "7140", 10);

const INSFORGE_URL = process.env.INSFORGE_URL ?? "http://localhost:7130";

const log = createLogger("server");

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

interface UserSessionRuntime {
  db: DbClient;
  repository: SessionRepository;
  service: SessionService;
}

interface SystemSessionRuntime {
  db: DbClient;
  repository: SessionRepository;
}

const COMMUNITY_SECTIONS = [
  { value: "prompt", label: "提示词技巧" },
  { value: "worldbuilding", label: "世界观构建" },
  { value: "character", label: "角色设计" },
  { value: "outline", label: "大纲与结构" },
  { value: "chapter", label: "章节写作" },
  { value: "tools", label: "工具分享" },
  { value: "showcase", label: "作品展示" },
  { value: "announcements", label: "官方公告" },
];

export { handleRequest };

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\.\//, ""));

if (isDirectRun) {
  startServer();
}

async function handleRequest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  for (const route of PUBLIC_ROUTES) {
    if (route.method && route.method !== req.method) continue;
    const m = route.pattern ? path.match(route.pattern) : (path === route.exact ? ([] as unknown as RegExpMatchArray) : null);
    if (!m) continue;
    await route.handler({ req, res, url, path });
    return;
  }

  const localMode = isLocalMode();

  // Local-first mode replaces the sign-in step with a locally minted identity.
  // There is no authorization server to ask, so a token is issued here from
  // JWT_SECRET and everything downstream — DbClient.forUser, PostgREST, RLS — behaves
  // exactly as it does for a signed-in hosted user. Any client-supplied token is
  // ignored: a local install is always the same person. See lib/local-mode.ts.
  let token = extractToken(req);
  let identity: Awaited<ReturnType<typeof deriveIdentity>>;
  if (localMode) {
    token ??= await mintDelegatedUserToken(LOCAL_IDENTITY);
    identity = LOCAL_IDENTITY;
  } else {
    if (!token) {
      // Allow anonymous community reads even without a token
      if (await handleCommunityAnonReads(req, res, url, path)) return;
      errorResponse(res, 401, "UNAUTHORIZED", "Missing Bearer token");
      return;
    }
    // Derive the authenticated user id from the verified access token.
    // This is the trust boundary: client-supplied user_id fields are never used
    // for authorization — only this server-derived identity.
    identity = await deriveIdentity(token);
  }
  if (!identity) {
    errorResponse(res, 401, "UNAUTHORIZED", "Invalid or expired token");
    return;
  }
  const { userId, email } = identity;

  try {
    const profileService = () => new ProfileService(
      DbClient.forUser(token),
      createContentStore({ mode: "user", token, bucket: "avatars", baseUrl: INSFORGE_URL }),
    );
    const paymentService = () => new PaymentService(DbClient.forSystem());
    const membershipService = () => new MembershipService(DbClient.forSystem());
    const communityService = () => new CommunityService(DbClient.forUser(token));
    const byokService = () => new ByokKeyService(DbClient.forSystem());
    // Policy ports: the core route handlers ask these instead of importing the SaaS
    // billing/membership modules. The composition root is the only place allowed to
    // know which implementation backs them (see docs/adr/0006-policy-ports.md).
    // Local mode holds every entitlement and bills nothing.
    const entitlements = () => localMode
      ? ALLOW_ALL_ENTITLEMENTS
      : createEntitlementPort((uid) => membershipService().getStatus(uid));
    const chatPreflight = () => localMode
      ? LOCAL_TURN_COST_POLICY
      : createTurnCostPolicy(token);

    const ctx: RouteContext = {
      req, res, url, path, token, identity, userId, email,
      params: [] as unknown as RegExpMatchArray,
      profileService, paymentService, membershipService, communityService, byokService,
      entitlements, chatPreflight,
    };

    for (const route of AUTH_ROUTES) {
      if (route.method && route.method !== req.method) continue;
      const m = route.pattern ? path.match(route.pattern) : (path === route.exact ? ([] as unknown as RegExpMatchArray) : null);
      if (!m) continue;
      ctx.params = m;
      await route.handler(ctx);
      return;
    }

    errorResponse(res, 404, "NOT_FOUND", "Not found");
  } catch (err: any) {
    if (err instanceof RegistrationError || err instanceof ReferralError) {
      errorResponse(res, err.status, err.code, err.message);
      return;
    }
    if (err instanceof CommunityServiceError) {
      errorResponse(res, err.status, err.code, err.message);
      return;
    }
    if (err instanceof SkillServiceError) {
      errorResponse(res, err.status, err.code, err.message);
      return;
    }
    if (err instanceof ProjectDomainError) {
      errorResponse(res, err.status, err.code, err.message, err.details);
      return;
    }
    if (err instanceof SessionDomainError) {
      errorResponse(res, err.status, err.code, err.message);
      return;
    }
    if (err instanceof ProfileInputError) {
      errorResponse(res, err.status, err.code, err.message);
      return;
    }
    if (err instanceof RequestBodyTooLargeError) {
      errorResponse(res, 413, "PAYLOAD_TOO_LARGE");
      return;
    }
    if (err instanceof PaymentError) {
      errorResponse(res, err.status, "PAYMENT_ERROR", err.message);
      return;
    }
    if (err instanceof SyntaxError) {
      errorResponse(res, 400, "INVALID_JSON", "Invalid JSON request body");
      return;
    }
    log.error("Request error:", err);
    errorResponse(res, 500, "INTERNAL_ERROR");
  }
}

function startServer() {
  const runtime = getSystemSessionRuntime();

  // Local-first mode owns exactly one user. `novel.projects.owner_id` references
  // `auth.users(id)`, so that row must exist before the first project is created.
  // Idempotent, so a restart is a no-op.
  if (isLocalMode()) {
    runtime.db.ensureUserRow({ userId: LOCAL_USER_ID, email: LOCAL_IDENTITY.email, nickname: "Local User" })
      .then(() => log.info("[startup] Local-first owner row ready"))
      .catch((error: unknown) => log.error(
        `[startup] Failed to ensure the local-first owner row: ${error instanceof Error ? error.message : String(error)}`,
      ));
  }

  getAgentResourceService().verifyRequired(REQUIRED_AGENT_RESOURCES).catch((error: unknown) => {
    log.error(`[startup] Agent resource verification failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  // Release any stale session leases left behind by a previous crash.
  // Uses the same TTL as the lease (10 min) plus a 5 min grace period.
  const STALE_LEASE_GRACE_MS = 15 * 60 * 1000;
  runtime.db.releaseStaleLeases(new Date(Date.now() - STALE_LEASE_GRACE_MS).toISOString())
    .then((count) => {
      if (count > 0) log.info(`[startup] Released ${count} stale session lease(s)`);
    })
    .catch((err: any) => {
      log.error(`[startup] Failed to release stale leases: ${err.message}`);
    });

  // Install built-in skills on startup so they appear in the Skill
  // Management page without requiring a chat session first.
  import("./lib/skills.js").then(({ installBuiltInSkills }) =>
    installBuiltInSkills("").then((installed) => {
      if (installed.length > 0) {
        log.info(`[startup] Installed ${installed.length} built-in skill(s): ${installed.join(", ")}`);
      }
    }).catch((err: any) => {
      log.error(`[startup] Failed to install built-in skills: ${err.message}`);
    }),
  );

  const stopMemoryWorker = startMemoryJobWorker({
    repository: runtime.repository,
    adapter: {
      capture: async (job) => {
        if (!process.env.MEMORI_API_KEY) return "degraded";
        const project = await runtime.db.getProject(job.project_id);
        const userId = project?.owner_id ? String(project.owner_id) : "";
        if (!userId) return "degraded";
        return createProjectMemoryAdapter(
          userId,
          job.project_id,
          job.session_id,
          runtime.repository,
        ).capture(job);
      },
    },
    intervalMs: 5_000,
    batchSize: 20,
  });
  const deletionRepository = new ProjectDeletionRepository(runtime.db);
  const stopDeletionWorker = startProjectDeletionWorker(new ProjectDeletionWorker({
    repository: deletionRepository,
    storage: createContentStore({ mode: "system", token: runtime.db.storageToken }),
    memory: {
      enumerateSessionMemoryIds: async (projectId, sessionId, requestedBy) => {
        if (!process.env.MEMORI_API_KEY) return [];
        const project = await runtime.db.getProject(projectId);
        const userId = requestedBy ?? (project?.owner_id ? String(project.owner_id) : null);
        if (!userId) throw new Error("Cannot determine memory owner for project purge");
        return createProjectMemoryAdapter(userId, projectId, sessionId, runtime.repository)
          .enumerateSessionMemoryIds(sessionId);
      },
    },
    batchSize: 5,
  }));
  const versionRepository = new DocumentVersionRepository(runtime.db);
  const stopDocumentVersionRepairWorker = startDocumentVersionRepairWorker(
    new DocumentVersionRepairWorker({
      repository: versionRepository,
      storageForProject: (projectId) => createContentStore({
        mode: "system",
        token: runtime.db.storageToken,
        bucket: "novels",
        projectId,
      }),
      batchSize: 20,
    }),
    5_000,
  );
  const stopContinuityWorker = startContinuityWorker(new ContinuityWorker({
    repository: runtime.db,
    // The composition root owns the choice of billing/entitlement implementation;
    // `continuity/` is creation-core and only receives the ports.
    execute: createSystemContinuityExecutor(runtime.db, {
      billing: new CreditBillingClient(runtime.db),
      entitlements: createEntitlementPort((userId) => new MembershipService(runtime.db).getStatus(userId)),
    }),
    batchSize: 5,
  }));
  const evictionTimer = setInterval(() => {
    for (const userRuntime of userSessionRuntimes.values()) {
      userRuntime.service.evictIdle(SESSION_IDLE_TTL_MS);
    }
  }, 5 * 60 * 1000);
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    log.info(`Novel Vibe Agent Server running on http://localhost:${PORT}`);
    log.info(`  Health:     http://localhost:${PORT}/api/health`);
    log.info(`  Chat:       POST http://localhost:${PORT}/api/chat`);
    log.info(`  Projects:   POST http://localhost:${PORT}/api/projects`);
    log.info(`  Documents:  GET  http://localhost:${PORT}/api/documents/:projectId`);
  });
  const shutdown = async () => {
    clearInterval(evictionTimer);
    await Promise.all([
      stopMemoryWorker(),
      stopDeletionWorker(),
      stopDocumentVersionRepairWorker(),
      stopContinuityWorker(),
    ]);
    server.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}
