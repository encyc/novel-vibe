/**
 * Shared mock kit for the Agent Server route tests.
 *
 * Every server/*.test.ts and server/routes/*.test.ts registers the same
 * vi.mock factories (importing this module dynamically inside the factory)
 * and calls resetServerMocks() in beforeEach. Module state here is fresh
 * per test file because vitest isolates module registries per file.
 */

import { vi } from "vitest";
import { signTestToken } from "../lib/auth.js";

export const DEFAULT_USER = "default-user";
export const authState = { defaultToken: "" };

export const mockResourceHealth = vi.fn(() => ({ status: "healthy", degraded: [] }));
export const mockVerifyRequired = vi.fn().mockResolvedValue({ status: "healthy", degraded: [] });
export const mockModelResolve = vi.fn().mockResolvedValue({ model: {}, source: "pi-ai" });

// Mock db module
export const mockDbInstance = {
  pgToken: "system-pg-token",
  createProject: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  updateProject: vi.fn(),
  transitionProjectLifecycle: vi.fn(),
  enqueueProjectDeletion: vi.fn(),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  upsertDocumentIndex: vi.fn(),
  enqueueContinuityJob: vi.fn(),
  claimDocumentWrite: vi.fn().mockResolvedValue({ outcome: "claimed", version_id: "version-1" }),
  completeDocumentWrite: vi.fn().mockResolvedValue({ version_no: 1 }),
  failDocumentWrite: vi.fn().mockResolvedValue(undefined),
  listDocumentVersions: vi.fn(),
  getDocumentVersion: vi.fn(),
  getDocumentVersionDiff: vi.fn(),
  claimDocumentVersionRepairs: vi.fn(),
  updateDocumentStatus: vi.fn(),
  listTasks: vi.fn(),
  createSession: vi.fn(),
  deleteDocument: vi.fn(),
  deleteForeshadow: vi.fn(),
  patchSessionMessageRow: vi.fn().mockResolvedValue({}),
  getUserProfile: vi.fn(),
  upsertUserProfile: vi.fn(),
  getCreditBalance: vi.fn(),
  getCreditActivity: vi.fn(),
  listCreditTransactionsCursor: vi.fn(),
  listCreditPackages: vi.fn(),
  createPurchase: vi.fn(),
  getPurchase: vi.fn(),
  completeCreditPurchase: vi.fn(),
  countProjectsByOwner: vi.fn().mockResolvedValue(0),
  getLevelConfig: vi.fn().mockResolvedValue({ name: "新用户" }),
  listMembershipPlans: vi.fn().mockResolvedValue([]),
  createMembershipPurchase: vi.fn(),
  getMembershipPurchase: vi.fn(),
  completeMembershipPurchase: vi.fn(),
  // Default to an active membership with unlimited_projects so the project-count
  // guard short-circuits; individual tests can override via mockReset/mockResolvedValue.
  getActiveMembership: vi.fn().mockResolvedValue({ active: true, features: ["unlimited_projects", "continuity"] }),
  getActiveMembershipUserIds: vi.fn().mockResolvedValue(new Set()),
  listActiveUserLlmKeys: vi.fn().mockResolvedValue([]),
  findActiveUserLlmKey: vi.fn().mockResolvedValue(null),
  upsertUserLlmKey: vi.fn(),
  revokeUserLlmKey: vi.fn().mockResolvedValue(true),
  requestRegistrationCode: vi.fn().mockResolvedValue({ accepted: true, retry_after_seconds: 60 }),
  verifyRegistrationCode: vi.fn().mockResolvedValue({ status: "verified", ticket_id: "ticket-id", expires_at: "2026-08-18T00:15:00Z" }),
  reserveRegistrationTicket: vi.fn().mockResolvedValue({ reservation_id: "reservation-id", expires_at: "2026-08-18T00:05:00Z" }),
  releaseRegistrationReservation: vi.fn().mockResolvedValue(true),
  finalizeRegistrationReservation: vi.fn().mockResolvedValue(true),
  previewReferralCode: vi.fn(),
  getReferralDashboard: vi.fn(),
  updateReferralCampaign: vi.fn(),
  getReferralAdminMetrics: vi.fn(),
  listReferralAdminBindings: vi.fn(),
  reviewReferralBinding: vi.fn(),
  listCreditRates: vi.fn().mockResolvedValue([]),
  listCommunityArticles: vi.fn(),
  getCommunityArticle: vi.fn(),
  createCommunityArticle: vi.fn(),
  getCommunityAuthorProfile: vi.fn(),
  listCommunityComments: vi.fn(),
  getCommunityComment: vi.fn(),
  createCommunityComment: vi.fn(),
  isCommunityAdmin: vi.fn(),
  setCommunityArticleFeatured: vi.fn(),
  hideCommunityArticle: vi.fn(),
  updateCommunityFeedbackStatus: vi.fn(),
  listCommunityFeedbackByAuthor: vi.fn(),
};

export const apiTokenRows: any[] = [];
export const mockApiTokenRepository = {
  insert: vi.fn(async (input: any) => {
    const row = {
      id: `token-${apiTokenRows.length + 1}`,
      public_id: input.publicId,
      secret_hash: input.secretHash,
      user_id: input.ownerId,
      name: input.name,
      scopes: input.scopes,
      expires_at: input.expiresAt,
      last_used_at: null,
      revoked_at: null,
      created_at: "2026-07-08T00:00:00.000Z",
    };
    apiTokenRows.push(row);
    return row;
  }),
  listByOwner: vi.fn(async (ownerId: string) => apiTokenRows
    .filter((row) => row.user_id === ownerId)
    .map(({ secret_hash: _secretHash, ...row }) => row)),
  findActiveByPublicId: vi.fn(),
  revokeOwned: vi.fn(async (tokenId: string, ownerId: string, revokedAt: string) => {
    const row = apiTokenRows.find((candidate) => candidate.id === tokenId
      && candidate.user_id === ownerId && candidate.revoked_at === null);
    if (!row) return false;
    row.revoked_at = revokedAt;
    return true;
  }),
  touchLastUsed: vi.fn(),
};

// Mock storage module
export const mockStorageInstance = {
  read: vi.fn(),
  write: vi.fn(),
  writeDocumentSnapshot: vi.fn(async (path: string, hash: string) => `.versions/${path}/${hash}.md`),
  delete: vi.fn(),
  writeBytes: vi.fn(),
  publicUrl: vi.fn((path: string) => `https://files.test/${path}`),
};

// Mock agents module
export const mockOrchestratorInstance = {
  init: vi.fn(),
  chat: vi.fn(),
  onAllEvents: vi.fn().mockReturnValue([]),
  hasMemory: vi.fn(),
  initMemory: vi.fn(),
  setSession: vi.fn(),
  setUserId: vi.fn(),
};

export const mockSessionService = {
  listSessions: vi.fn(),
  createSession: vi.fn(),
  openSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  archiveSession: vi.fn(),
  restoreSession: vi.fn(),
  interruptSession: vi.fn(),
  listMessages: vi.fn(),
  chat: vi.fn(),
  evictIdle: vi.fn(),
};

export const mockSkillReviewService = {
  createDraft: vi.fn(),
  getDraft: vi.fn(),
  reviewDraft: vi.fn(),
  confirmDraft: vi.fn(),
  cancelDraft: vi.fn(),
};

// ---- vi.mock factories (referenced dynamically by every route test file) ----

export function agentResourcesMockFactory() {
  return {
    getAgentResourceService: () => ({ health: mockResourceHealth, verifyRequired: mockVerifyRequired }),
  };
}

export function modelResolverMockFactory() {
  return {
    getSystemModelResolver: () => ({ resolve: mockModelResolve }),
    getSystemModelHealthService: () => ({ observeFailure: vi.fn() }),
  };
}

export function apiTokenRepoMockFactory() {
  return { ApiTokenRepository: vi.fn().mockImplementation(() => mockApiTokenRepository) };
}

export function dbMockFactory() {
  return {
    DbClient: {
      forUser: vi.fn().mockImplementation(() => mockDbInstance),
      forSystem: vi.fn().mockImplementation(() => mockDbInstance),
      forAnon: vi.fn().mockImplementation(() => mockDbInstance),
    },
  };
}

export async function storageMockFactory(importOriginal: () => Promise<unknown>) {
  return {
    ...(await importOriginal() as Record<string, unknown>),
    StorageClient: {
      forUser: vi.fn().mockImplementation(() => mockStorageInstance),
      forSystem: vi.fn().mockImplementation(() => mockStorageInstance),
    },
  };
}

export function agentsMockFactory() {
  return { NovelOrchestrator: vi.fn().mockImplementation(() => mockOrchestratorInstance) };
}

export function sessionServiceMockFactory() {
  return {
    SessionService: vi.fn().mockImplementation(() => mockSessionService),
    SessionTurnInterruptedError: class SessionTurnInterruptedError extends Error {
      constructor() {
        super("Generation interrupted by user");
        this.name = "SessionTurnInterruptedError";
      }
    },
  };
}

export function frontmatterMockFactory() {
  return {
    countWords: vi.fn().mockReturnValue(100),
    hashContent: vi.fn().mockImplementation((content: string) => `hash:${content}`),
    parseFrontmatter: vi.fn().mockReturnValue({
      frontmatter: {
        type: "character", name: "Test", slug: "test", role: "supporting", status: "draft",
        tags: [], abilities: [], arc_stage: "origin", appears_in: [],
      },
      body: "# Test\n\nContent",
    }),
    getDocDir: vi.fn().mockReturnValue("characters"),
  };
}

export function skillsMockFactory() {
  return {
    listAllSkillsForUI: vi.fn().mockResolvedValue([]),
    uninstallSkill: vi.fn().mockResolvedValue(undefined),
    loadSkillForUI: vi.fn().mockResolvedValue(null),
    getWorkspaceSkills: vi.fn().mockResolvedValue([]),
    toggleWorkspaceSkill: vi.fn().mockResolvedValue(undefined),
  };
}

export function skillReviewMockFactory() {
  return { createSkillReviewService: vi.fn(() => mockSkillReviewService) };
}

// ---- request/response helpers ----

export function mockReq(overrides: Record<string, unknown> = {}) {
  const req: Record<string, unknown> = {
    method: "GET",
    url: "/api/health",
    headers: { authorization: `Bearer ${authState.defaultToken}` },
    on: vi.fn(),
    ...overrides,
  };
  return req;
}

export function mockRes() {
  const res: Record<string, unknown> = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
    write: vi.fn(),
  };
  return res;
}

export function mockBody(req: Record<string, unknown>, body: unknown) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  (req.on as any).mockImplementation((event: string, cb: Function) => {
    if (event === "data") {
      chunks.forEach((c) => cb(c));
    }
    if (event === "end") {
      cb();
    }
  });
}

export function mockNoBody(req: Record<string, unknown>) {
  (req.on as any).mockImplementation((event: string, cb: Function) => {
    if (event === "end") cb();
  });
}

export function mockRawBody(req: Record<string, unknown>, body: string | Buffer) {
  const chunks = [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  (req.on as any).mockImplementation((event: string, cb: Function) => {
    if (event === "data") chunks.forEach((chunk) => cb(chunk));
    if (event === "end") cb();
  });
}

// ---- per-suite reset (was the describe-level beforeEach) ----

export async function resetServerMocks() {
  vi.clearAllMocks();
  apiTokenRows.length = 0;
  mockDbInstance.getProject.mockResolvedValue({ id: "p1", lifecycle_status: "active" });
  process.env.JWT_SECRET = "test-secret-32-chars-minimum!!";
  process.env.NOVEL_VIBE_PORT = "7140";
  process.env.INSFORGE_URL = "http://localhost:7130";
  authState.defaultToken = await signTestToken(DEFAULT_USER, process.env.JWT_SECRET);
  mockDbInstance.getUserProfile.mockResolvedValue({ id: DEFAULT_USER, nickname: "墨白", avatar_url: null, locale: "zh-CN" });
  mockDbInstance.getCreditBalance.mockResolvedValue({ balance: 10, total_granted: 20, total_consumed: 10 });
  mockDbInstance.getCreditActivity.mockResolvedValue([]);
  mockDbInstance.listCreditTransactionsCursor.mockResolvedValue([]);
  mockDbInstance.listCreditPackages.mockResolvedValue([]);
}
