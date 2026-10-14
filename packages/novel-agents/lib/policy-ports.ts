/**
 * Policy ports: the seams that let the creation core gate on paid capabilities and
 * meter model usage without depending on the SaaS subsystems that implement them.
 *
 * The direction matters. The core asks "may this user do X?" and "bill this usage";
 * entitlements, credit balances, pricing tables and the membership catalog all live
 * on the SaaS side. Defining the shapes here means a local-first build can supply a
 * permissive implementation and never link the SaaS modules at all — the same
 * pattern as `ContentStore`.
 *
 * Conformance is proven by the implementations, not by this file: the SaaS
 * adapters assert assignability against these interfaces at compile time.
 */

import type { PricingQuote, UsageRecordParams } from "./usage-cost-types.js";

// ─── Entitlements ───────────────────────────────────────────────────

/**
 * The entitlements the creation core actually gates on.
 *
 * Deliberately closed and small: each member is a real branch in core code, so
 * adding one is a deliberate act. It is NOT a mirror of the SaaS membership
 * catalog (`billing/entitlements.ts` owns that, and keeps its own broader key set).
 */
export type CoreEntitlement =
  | "byok"
  | "premium_models"
  | "export"
  | "unlimited_projects"
  | "web_search"
  | "continuity";

export interface EntitlementPort {
  /** True when the user currently holds the entitlement. Never throws for a normal user. */
  has(userId: string, entitlement: CoreEntitlement): Promise<boolean>;
}

/**
 * Local-first / single-user implementation: the person running the software owns
 * it, so every capability is available.
 */
export const ALLOW_ALL_ENTITLEMENTS: EntitlementPort = Object.freeze({
  has: async () => true,
});

// ─── Usage billing ──────────────────────────────────────────────────

/**
 * The billing operations the agent runtime performs on a turn.
 *
 * Mirrors the subset of the SaaS credit client that `attachUsageTracker` consumes.
 * Kept structural so the core never imports `lib/credits.ts`; the SaaS adapter
 * proves at compile time that `CreditBillingClient` satisfies it.
 */
export interface TurnUsageBilling {
  /**
   * Lock the price for one model call before it happens.
   *
   * Returns `null` when the call is not billed at all — local mode, where the
   * user's own key pays the provider. Returning `null` rather than inventing a
   * zero-credit quote keeps the meaning explicit: "there is nothing to charge",
   * not "this was free".
   */
  createPricingQuote(params: {
    userId: string;
    modelId: string;
    modelProvider: string;
    requestStartedAt: Date;
  }): Promise<PricingQuote | null>;

  /** Charge a completed call against its quote. */
  recordAndChargeQuotedUsage(params: UsageRecordParams & { quote: PricingQuote }): Promise<void>;

  /** Record a BYOK call for audit only — the user's own key pays the provider. */
  recordByokUsage(params: UsageRecordParams): Promise<void>;
}

/**
 * Local-first implementation: nothing is billed on the platform, so no quote is
 * produced and no charge is recorded. Usage metering still runs; it simply has
 * nothing to settle.
 */
export const LOCAL_TURN_USAGE_BILLING: TurnUsageBilling = Object.freeze({
  createPricingQuote: async () => null,
  recordAndChargeQuotedUsage: async () => undefined,
  recordByokUsage: async () => undefined,
});

// ─── Turn cost policy ───────────────────────────────────────────────

/**
 * The three cost questions a chat turn asks before it starts generating.
 *
 * The core keeps the *gate itself* — the branch order and every user-facing
 * message stay in `server/routes/chat.ts` — and asks the SaaS layer only for the
 * facts it cannot know: which models are premium, which are free, and what the
 * user's balance is.
 */
export interface TurnCostPolicy {
  /** True when the model is reserved for a paid tier. */
  isPremiumModel(modelId: string): boolean;
  /** True when the model costs the user nothing (all rate components zero). */
  isFreeModel(modelId: string, provider: string): Promise<boolean>;
  /** Current platform balance, or null when the user has no balance row yet. */
  getBalance(userId: string): Promise<{ balance: number } | null>;
}

/**
 * Local-first implementation: the user's own model key pays the provider and there
 * is no platform balance to exhaust, so no turn is ever refused for cost.
 *
 * `isPremiumModel` is false because premium is a hosted-tier concept, and
 * `isFreeModel` is true because nothing here is billed. Together they make the
 * pre-flight in `server/routes/chat.ts` pass without a membership or balance
 * lookup — the gate itself is untouched, only its inputs change.
 */
export const LOCAL_TURN_COST_POLICY: TurnCostPolicy = Object.freeze({
  isPremiumModel: () => false,
  isFreeModel: async () => true,
  getBalance: async () => null,
});

/**
 * Raised when a turn is refused because the platform balance is exhausted.
 *
 * Core-owned so `chat.ts` can both throw it and classify it (`instanceof`) without
 * importing the SaaS client. It is the *only* failure that may be surfaced to the
 * user as "please top up": infrastructure permission errors and upstream provider
 * quota problems must not masquerade as a user balance issue.
 *
 * `lib/credits.ts` re-exports this class, so existing import sites and every
 * `instanceof` check keep working — there is exactly one class identity.
 */
export class InsufficientCreditsError extends Error {
  readonly balance: number;

  constructor(balance: number) {
    super(`Insufficient credit balance: ${balance}`);
    this.name = "InsufficientCreditsError";
    this.balance = balance;
  }
}
