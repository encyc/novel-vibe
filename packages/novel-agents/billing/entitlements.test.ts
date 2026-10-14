import { describe, expect, it } from "vitest";
import {
  MEMBERSHIP_ENTITLEMENT_CATALOG,
  MEMBERSHIP_FEATURE_KEYS,
  isPremiumModel,
  hasMembershipFeature,
} from "./entitlements.js";

describe("membership entitlements catalog", () => {
  it("keeps catalog keys and the closed key union in sync", () => {
    const catalogKeys = MEMBERSHIP_ENTITLEMENT_CATALOG.map((entry) => entry.key).sort();
    expect(catalogKeys).toEqual([...MEMBERSHIP_FEATURE_KEYS].sort());
  });

  it("sorts catalog entries by sortOrder without duplicates", () => {
    const orders = MEMBERSHIP_ENTITLEMENT_CATALOG.map((entry) => entry.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe("isPremiumModel", () => {
  it("gates flagship model families by id prefix", () => {
    expect(isPremiumModel("claude-opus-4-8")).toBe(true);
    expect(isPremiumModel("gpt-5.6-terra")).toBe(true);
    expect(isPremiumModel("kimi-k3")).toBe(true);
  });

  it("lets standard models and near-miss ids through", () => {
    expect(isPremiumModel("deepseek-v4-flash")).toBe(false);
    expect(isPremiumModel("claude-sonnet-4-5")).toBe(false);
    expect(isPremiumModel("gpt-5.6-luna")).toBe(false);
    expect(isPremiumModel("kimi-k2.7-code")).toBe(false);
  });
});

describe("byok entitlement", () => {
  it("is part of the closed feature union and catalog", () => {
    expect(MEMBERSHIP_FEATURE_KEYS).toContain("byok");
    const entry = MEMBERSHIP_ENTITLEMENT_CATALOG.find((item) => item.key === "byok");
    expect(entry?.category).toBe("models");
  });

  it("gates on active membership carrying the byok feature", () => {
    expect(hasMembershipFeature({ active: true, features: ["byok"] }, "byok")).toBe(true);
    expect(hasMembershipFeature({ active: true, features: ["premium_models"] }, "byok")).toBe(false);
    expect(hasMembershipFeature({ active: false, features: ["byok"] }, "byok")).toBe(false);
  });
});

describe("hasMembershipFeature", () => {
  it("grants a feature for an active membership listing it", () => {
    expect(hasMembershipFeature({ active: true, features: ["export", "web_search"] }, "export")).toBe(true);
  });

  it("denies when membership is inactive even if the feature is listed", () => {
    expect(hasMembershipFeature({ active: false, features: ["export"] }, "export")).toBe(false);
  });

  it("denies when the feature is absent", () => {
    expect(hasMembershipFeature({ active: true, features: ["export"] }, "web_search")).toBe(false);
  });

  it("denies on missing, null, or malformed status shapes", () => {
    expect(hasMembershipFeature(undefined, "export")).toBe(false);
    expect(hasMembershipFeature(null, "export")).toBe(false);
    expect(hasMembershipFeature({}, "export")).toBe(false);
    expect(hasMembershipFeature({ active: true }, "export")).toBe(false);
    expect(hasMembershipFeature({ active: true, features: "export" }, "export")).toBe(false);
    expect(hasMembershipFeature({ active: true, features: null }, "export")).toBe(false);
  });
});
