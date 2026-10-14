export interface User {
  id: string;
  email: string;
  isCommunityAdmin?: boolean;
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  locale: "zh-CN" | "en";
}
export interface CreditSummary { balance: number; totalGranted: number; totalConsumed: number; level: number; levelName: string }
export interface CreditActivityDay { date: string; creditsConsumed: number; totalTokens: number }
export type PurchaseStatus = "pending" | "completed" | "failed";
export interface CreditTransaction {
  id: string;
  type: "consume" | "topup";
  amount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: string;
  orderNo?: string | null;
  paymentStatus?: PurchaseStatus;
}
export interface CreditPackage { id: string; name: string; priceCents: number; credits: number; bonusCredits: number }
export interface MembershipPlan { id: string; slug: string; name: string; priceCents: number; durationDays: number; bonusCredits: number; features: string[] }
export interface MembershipStatus { active: boolean; planName: string | null; expiresAt: string | null; features: string[] }
export type MembershipFeatureCategory = "workspace" | "creation" | "models" | "community";
export interface MembershipEntitlement { key: string; category: MembershipFeatureCategory; sortOrder: number }
type ReferralUnavailableReason = "campaign_closed" | "inviter_inactive" | "capacity_full" | "invalid_code";
export interface ReferralPreview {
  valid: boolean; code: string; rewardDays: number; purchaseWindowDays: number;
  bindingEndsAt: string | null; unavailableReason?: ReferralUnavailableReason;
}
export interface ReferralDashboard {
  code: string; shareUrl: string; canInvite: boolean; unavailableReason?: ReferralUnavailableReason;
  campaign: { bindingEndsAt: string; rewardDays: number; maxSlots: number } | null;
  counts: { successful: number; pending: number; remaining: number };
  invitations: Array<{ id: string; maskedEmail: string; boundAt: string; purchaseDeadline: string; status: string }>;
  inviteeBinding: { status: string; purchaseDeadline: string } | null;
  rewards: Array<{ role: "inviter" | "invitee"; days: number; grantedAt: string; expiresAt: string }>;
}
export interface ReferralAdminMetrics {
  campaign: { id: string; slug: string; binding_ends_at: string; purchase_window_days: number; reward_days: number; max_slots_per_inviter: number };
  totals: { landings: number; verified_emails: number; bindings: number; pending: number; risk_pending: number; expired: number; successful: number; reward_days: number };
}
export interface ReferralAdminBinding {
  id: string; inviter_user_id: string; invitee_user_id: string; invitee_email: string;
  status: string; risk_reasons: string[]; bound_at: string; purchase_deadline: string;
  qualifying_purchase_id: string | null;
}

/** A selectable LLM, sourced from InsForge credit_rates via GET /api/models. */
export interface AiModel {
  /** Stable selection key — `${provider}:${model_pattern}`. */
  id: string;
  name: string;
  provider: string;
  /** Display label for the provider group (BYOK models carry the provider's name). */
  providerLabel?: string;
  model: string;
  /** Credits per 1M tokens (rounded). Optional, for display only. */
  inputRate?: number;
  outputRate?: number;
}

export interface Project {
  id: string;
  title: string;
  genre?: string | null;
  synopsis?: string | null;
  owner_id?: string | null;
  storage_path?: string | null;
  created_at?: string;
  updated_at?: string;
  lifecycle_status?: "active" | "archived" | "trash";
  writing_stage?: "planning" | "drafting" | "revising" | "completed";
  archived_at?: string | null;
  deleted_at?: string | null;
  purge_after?: string | null;
  last_activity_at?: string;
  creative_language: "zh-CN" | "en";
}

export interface DocumentIndex {
  project_id: string;
  doc_path: string;
  doc_type: string;
  name?: string | null;
  status?: string | null;
  chapter_num?: number | null;
  volume_num?: number | null;
  word_count?: number | null;
  updated_at?: string;
  meta?: Record<string, unknown> | null;
}

export interface DocumentSource {
  content: string;
  hash: string;
  path: string;
}

export type DocumentSaveResult =
  | { ok: true; changed: false; hash: string; path: string; indexed: false }
  | { ok: true; changed: true; hash: string; path: string; indexed: boolean; versionId: string; versionNo: number };

interface InlineDiffSpan {
  kind: "same" | "insert" | "delete";
  text: string;
}

export interface DocumentDiffLine {
  kind: "context" | "insert" | "delete";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  spans?: InlineDiffSpan[];
}

interface DocumentDiffHunk {
  index: number;
  section: string | null;
  oldStart: number;
  newStart: number;
  lines: DocumentDiffLine[];
}

interface FrontmatterChange {
  key: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface DocumentDiffPage {
  algorithmVersion: "jsdiff-v1";
  status: "ready" | "unavailable";
  items: DocumentDiffHunk[];
  frontmatterChanges: FrontmatterChange[];
  addedLines: number;
  deletedLines: number;
  changedSections: string[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface DocumentVersionSummary {
  id: string;
  projectId: string;
  path: string;
  versionNo: number;
  sourceType: "agent" | "user" | "system";
  agentId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  createdBy?: string;
  beforeHash: string | null;
  afterHash: string;
  state: "complete";
  diffStatus: "ready" | "unavailable";
  addedLines: number;
  deletedLines: number;
  changedSections: string[];
  createdAt: string;
  completedAt: string;
}

export interface DocumentConflict {
  error: string;
  code: "DOCUMENT_CONFLICT";
  content: string;
  hash: string;
  path: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  title: string;
  titleIsCustom?: boolean;
  isProcessing: boolean;
  processingStartedAt?: string | null;
  memoryStatus: "healthy" | "degraded";
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
  lifecycleStatus?: "active" | "archived";
}

export interface SessionMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  status: "running" | "complete" | "failed" | "interrupted";
  createdAt: string;
  trace?: PersistedChatTrace;
  interactions?: SessionInteraction[];
  interactionResponse?: InteractionResponseV1;
}

interface InteractionOption {
  value: string;
  label: string;
  description?: string;
}

interface InteractionFieldBase {
  id: string;
  label: string;
  description?: string;
  required: boolean;
}

export type InteractionField =
  | (InteractionFieldBase & { type: "radio"; options: InteractionOption[] })
  | (InteractionFieldBase & { type: "checkbox"; minSelections?: number; maxSelections?: number; options: InteractionOption[] })
  | (InteractionFieldBase & { type: "text" | "textarea"; placeholder?: string; maxLength: number });

interface InteractionDocumentReference {
  path: string;
  versionId: string;
  versionNo: number;
  label?: string;
}

export interface InteractionRequestV1 {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  fields: InteractionField[];
  references: InteractionDocumentReference[];
  submitLabel?: string;
  allowFreeAnswer: boolean;
}

export type InteractionAnswer =
  | { fieldId: string; type: "radio" | "text" | "textarea"; value: string }
  | { fieldId: string; type: "checkbox"; value: string[] };

export interface InteractionResponseV1 {
  schemaVersion: 1;
  interactionId: string;
  idempotencyKey: string;
  answers: InteractionAnswer[];
  freeAnswer?: string;
}

export interface SessionInteraction {
  id: string;
  assistantMessageId: string;
  request: InteractionRequestV1;
  status: "pending" | "resolved" | "cancelled";
  response?: InteractionResponseV1;
  respondedAt?: string;
}

export interface RunPlanV1 {
  schemaVersion: 1;
  id: string;
  title: string;
  items: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" }>;
}

type PersistedTraceStep =
  | { type: "agent"; id: string; agentId: AgentId; parentToolCallId?: string; status: "running" | "finished" }
  | { type: "thinking"; id: string; agentId: AgentId; parentToolCallId?: string; summary: string; status: "running" | "finished"; truncated?: boolean }
  | { type: "tool"; id: string; agentId: AgentId; parentToolCallId?: string; toolName: string; args: unknown; partialResult?: unknown; result?: unknown; isError?: boolean; durationMs?: number; status: "running" | "succeeded" | "failed"; truncated?: boolean }
  | { type: "document_change"; id: string; agentId: AgentId; toolCallId: string; versionId: string; path: string; versionNo: number; addedLines: number; deletedLines: number; changedSections: string[] }
  | { type: "output"; id: string; agentId: AgentId; parentToolCallId?: string; text: string; truncated?: boolean }
  | { type: "run_plan"; id: string; plan: RunPlanV1 }
  | { type: "interaction"; id: string; interaction: InteractionRequestV1; status: "pending" | "resolved"; answers?: InteractionAnswer[]; freeAnswer?: string };

export interface PersistedChatTrace {
  version: 1;
  runId?: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  startedAt?: number;
  durationMs?: number;
  error?: string;
  steps: PersistedTraceStep[];
  truncated?: boolean;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SessionPage extends CursorPage<ChatSession> {
  activeSessionId: string | null;
}

export type AgentId =
  | "chief_editor"
  | "worldbuilder"
  | "character_designer"
  | "outliner"
  | "director"
  | "writer"
  | "script_supervisor";

export type SkillRole = AgentId;
type SkillDraftStatus = "draft" | "reviewing" | "revision_required" | "awaiting_confirmation" | "rejected" | "cancelled" | "installed";

export interface SkillDraft {
  id: string;
  slug: string;
  source: "upload" | "paste" | "skill_creator";
  originalContent: string;
  candidateContent: string;
  roles: SkillRole[];
  status: SkillDraftStatus;
  version: number;
}

interface SkillReviewFinding {
  code: string;
  severity: "error" | "warning";
  line?: number;
  message: string;
}

export interface SkillReview {
  id: string;
  draftId: string;
  draftVersion: number;
  verdict: "approved" | "revision_required" | "rejected" | "failed";
  findings: SkillReviewFinding[];
  requiredCapabilities: string[];
  recommendedRoles: SkillRole[];
  candidateHash: string;
}

export interface InstalledSkill {
  slug: string;
  source: "built-in" | "user";
  metadata: { name: string; description: string };
  content: string;
  path: string;
  reviewStatus?: "approved" | "review_required" | "quarantined";
  roles?: SkillRole[];
}

export interface WorkspaceSkill {
  slug: string;
  name: string;
  description?: string;
  enabled: boolean;
  reviewStatus?: "approved" | "review_required" | "quarantined";
}

/** Version history entry for an installed user skill (evolution / revert snapshots). */
export interface SkillVersionSummary {
  versionNumber: number;
  snapshotReason: "evolution" | "revert" | "install";
  createdAt: string;
  contentHash: string;
}

interface ChatStreamEventBase {
  version: 1;
  runId: string;
  seq: number;
  timestamp: number;
  agentId?: AgentId;
  parentToolCallId?: string;
}

export type ChatStreamEvent =
  | (ChatStreamEventBase & { type: "run_started" })
  | (ChatStreamEventBase & { type: "agent_started"; agentId: AgentId })
  | (ChatStreamEventBase & { type: "agent_finished"; agentId: AgentId })
  | (ChatStreamEventBase & { type: "thinking_started" | "thinking_finished"; agentId: AgentId; blockId: string; text?: string })
  | (ChatStreamEventBase & { type: "thinking_delta"; agentId: AgentId; blockId: string; delta: string })
  | (ChatStreamEventBase & { type: "answer_delta"; agentId: "chief_editor"; delta: string })
  | (ChatStreamEventBase & { type: "agent_output_delta"; agentId: Exclude<AgentId, "chief_editor">; delta: string })
  | (ChatStreamEventBase & { type: "tool_started"; agentId: AgentId; toolCallId: string; toolName: string; args: unknown })
  | (ChatStreamEventBase & { type: "tool_updated"; agentId: AgentId; toolCallId: string; toolName: string; partialResult: unknown })
  | (ChatStreamEventBase & { type: "tool_finished"; agentId: AgentId; toolCallId: string; toolName: string; result: unknown; isError: boolean; durationMs: number })
  | (ChatStreamEventBase & { type: "document_changed"; agentId: AgentId; toolCallId: string; versionId: string; path: string; versionNo: number; addedLines: number; deletedLines: number; changedSections: string[] })
  | (ChatStreamEventBase & { type: "run_plan_updated"; plan: RunPlanV1 })
  | (ChatStreamEventBase & { type: "interaction_requested"; interaction: InteractionRequestV1 })
  | (ChatStreamEventBase & { type: "interaction_resolved"; interactionId: string; answers: InteractionAnswer[]; freeAnswer?: string })
  | (ChatStreamEventBase & { type: "answer_finished"; text: string })
  | (ChatStreamEventBase & { type: "run_finished"; durationMs: number })
  | (ChatStreamEventBase & { type: "run_interrupted"; message: string; durationMs: number })
  | (ChatStreamEventBase & { type: "run_failed"; message: string; durationMs: number });

// ---------------------------------------------------------------------------
// Community
// ---------------------------------------------------------------------------

export type CommunitySection =
  | "prompt" | "worldbuilding" | "character" | "outline"
  | "chapter" | "tools" | "showcase" | "announcements";

type CommunityArticleStatus = "draft" | "published" | "hidden" | "deleted";
export type CommunityKind = "article" | "bug" | "feature_request" | "announcement";
export type CommunityFeedbackStatus = "open" | "fixed" | "closed" | "planned" | "shipped" | "declined";
export type CommunitySort = "latest" | "popular" | "ranked";

interface CommunityAuthor {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  isOfficial: boolean;
  isMember?: boolean;
}

export interface CommunityArticleSummary {
  id: string;
  author: CommunityAuthor;
  title: string;
  excerpt: string | null;
  section: CommunitySection;
  tags: string[];
  kind: CommunityKind;
  isFeatured: boolean;
  feedbackStatus: CommunityFeedbackStatus | null;
  commentsEnabled: boolean;
  likeCount: number;
  commentCount: number;
  bookmarkCount: number;
  publishedAt: string | null;
}

export interface CommunityArticleDetail extends CommunityArticleSummary {
  body: string;
  status: CommunityArticleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityComment {
  id: string;
  articleId: string;
  author: CommunityAuthor;
  rootId: string | null;
  replyToUserId: string | null;
  body: string;
  likeCount: number;
  status: string;
  createdAt: string;
}

export interface CommunityAuthorProfile {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  isOfficial: boolean;
  isMember?: boolean;
  bio: string | null;
  articleCount: number;
  followerCount: number;
}

export interface CommunityArticlePage {
  items: CommunityArticleSummary[];
  nextCursor: string | null;
}

/** The caller's feedback is a compact, unpaginated bug/feature list, so it
 * intentionally does not carry a cursor. */
export interface CommunityFeedbackPage {
  items: CommunityArticleSummary[];
}

export interface CommunityInteractions {
  [articleId: string]: { liked: boolean; bookmarked: boolean };
}

export interface CommunitySectionMeta {
  value: CommunitySection;
  label: string;
}

interface DelegationTranscriptBlock {
  kind: "text" | "reasoning" | "tool";
  text: string;
}

export interface DelegationTranscriptEntry {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "tool";
  blocks: DelegationTranscriptBlock[];
  createdAt: string;
}
