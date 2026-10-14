/**
 * SaaS side of the core's policy seams.
 *
 * The creation core asks policy questions through ports it owns
 * (`lib/policy-ports.ts`): `EntitlementPort` for membership gates and
 * `TurnCostPolicy` for the chat turn pre-flight. This module is the hosted
 * implementation of both. Only the SaaS layer may import the membership catalog and
 * the credit client, and only the composition root (`server.ts` /
 * `server/runtime.ts`) may construct these adapters and hand them to the core.
 *
 * Everything here is deliberately a thin projection of SaaS subsystems: no branch
 * semantics live in this file, so the core's error messages and gating order stay
 * byte-identical to the pre-port implementation.
 */

import { hasMembershipFeature, isPremiumModel, type MembershipFeatureKey } from "./entitlements.js";
import { CreditBillingClient } from "../lib/credits.js";
import { DbClient } from "../lib/db.js";
import type { CoreEntitlement, EntitlementPort, TurnCostPolicy } from "../lib/policy-ports.js";

/**
 * Explicit bridge between the core's closed entitlement vocabulary and the SaaS
 * membership catalog.
 *
 * The two vocabularies are deliberately separate: `CoreEntitlement` names only the
 * gates the core actually branches on, while `MEMBERSHIP_FEATURE_KEYS` is the
 * broader catalog sold to users. Writing the mapping out by hand means a catalog
 * rename is a one-line change here, and a new core gate is a deliberate edit to the
 * union (the `Record` stops compiling until this file is updated too).
 */
const FEATURE_BY_ENTITLEMENT: Record<CoreEntitlement, MembershipFeatureKey> = {
  byok: "byok",
  premium_models: "premium_models",
  export: "export",
  unlimited_projects: "unlimited_projects",
  web_search: "web_search",
  continuity: "continuity",
};

/**
 * Adapt a membership-status lookup into the core's entitlement port.
 *
 * @param getMembershipStatus Reads the current membership status for a user. The
 *   shape is structural on purpose (raw `getActiveMembership` rows and
 *   `MembershipStatusView` both satisfy it).
 *
 * Lookup failures propagate to the caller instead of being folded into `false`:
 * `tools/web-tools.ts` distinguishes "not entitled" (`MEMBERSHIP_REQUIRED`) from
 * "entitlement lookup failed" (`WEB_SEARCH_AUTHORIZATION_UNAVAILABLE`), so
 * swallowing an error here would silently change a user-visible branch.
 */
export function createEntitlementPort(
  getMembershipStatus: (userId: string) => Promise<{ active?: boolean | null; features?: unknown } | null | undefined>,
): EntitlementPort {
  return {
    has: async (userId, entitlement) => {
      const status = await getMembershipStatus(userId);
      return hasMembershipFeature(status, FEATURE_BY_ENTITLEMENT[entitlement]);
    },
  };
}

/**
 * Adapt the SaaS pricing/credit client into the core's turn-cost policy.
 *
 * Reasons this implementation lives on the SaaS side rather than in the route:
 * - `isPremiumModel` is catalog data owned by `billing/entitlements.ts`;
 * - pricing and balance tables are SaaS-owned, and `server/routes/chat.ts` must
 *   stop importing `lib/credits.ts` altogether.
 *
 * The gate itself — branch order, `InsufficientCreditsError` (now core-owned) and
 * every user-facing message — stays in `chat.ts`; this adapter only answers the
 * three facts the core cannot know.
 *
 * @param token The request's bearer token. The client is user-scoped exactly like
 *   the previous in-route `new CreditBillingClient(DbClient.forUser(token))`.
 */
export function createTurnCostPolicy(token: string): TurnCostPolicy {
  const billing = new CreditBillingClient(DbClient.forUser(token));
  return {
    isPremiumModel: (modelId) => isPremiumModel(modelId),
    isFreeModel: (modelId, provider) => billing.isFreeModel(modelId, provider),
    getBalance: async (userId) => {
      const balance = await billing.getBalance(userId);
      return balance ? { balance: balance.balance } : null;
    },
  };
}
