/**
 * Membership entitlements catalog.
 *
 * The DB owns "who has what": `membership_plans.features` holds feature keys and
 * each purchase snapshots them. This module owns "what a feature means": the
 * closed key union plus display metadata served to the WebUI. Enforcement
 * points check membership through `hasMembershipFeature` instead of raw
 * string literals, so adding a benefit means adding one catalog entry plus one
 * gate — never another scattered whitelist.
 */

export const MEMBERSHIP_FEATURE_KEYS = [
  "unlimited_projects",
  "export",
  "web_search",
  "continuity",
  "premium_models",
  "byok",
  "community_badge",
] as const;

export type MembershipFeatureKey = (typeof MEMBERSHIP_FEATURE_KEYS)[number];

export type MembershipFeatureCategory = "workspace" | "creation" | "models" | "community";

export interface MembershipEntitlementMeta {
  key: MembershipFeatureKey;
  category: MembershipFeatureCategory;
  sortOrder: number;
}

export const MEMBERSHIP_ENTITLEMENT_CATALOG: readonly MembershipEntitlementMeta[] = [
  { key: "unlimited_projects", category: "workspace", sortOrder: 10 },
  { key: "export", category: "creation", sortOrder: 20 },
  { key: "web_search", category: "creation", sortOrder: 30 },
  { key: "continuity", category: "creation", sortOrder: 40 },
  { key: "premium_models", category: "models", sortOrder: 50 },
  { key: "byok", category: "models", sortOrder: 55 },
  { key: "community_badge", category: "community", sortOrder: 60 },
];

/**
 * Flagship model id prefixes gated behind the `premium_models` entitlement.
 * Ids come from `credit_rates.model_pattern` (e.g. "claude-opus-4-8"). The
 * list is code-owned on purpose: promoting a model to premium is a deliberate
 * product decision, not a data toggle.
 */
export const PREMIUM_MODEL_PREFIXES = [
  "claude-opus-",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "kimi-k3",
] as const;

export function isPremiumModel(modelId: string): boolean {
  return PREMIUM_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

/** Loose enough for both `MembershipStatusView` and raw `getActiveMembership` rows. */
export type MembershipFeatureStatusLike = {
  active?: boolean | null;
  features?: unknown;
};

export function hasMembershipFeature(
  status: MembershipFeatureStatusLike | null | undefined,
  feature: MembershipFeatureKey,
): boolean {
  if (!status || status.active !== true) return false;
  return Array.isArray(status.features) && status.features.includes(feature);
}
