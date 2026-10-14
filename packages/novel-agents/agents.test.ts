import { describe, expect, it } from "vitest";
import { NovelOrchestrator, type NovelOrchestratorConfig } from "./agents.js";
import type { ByokTurnState } from "./lib/byok.js";
import { ALLOW_ALL_ENTITLEMENTS, type TurnUsageBilling } from "./lib/policy-ports.js";

// The orchestrator's tool context builds user-scoped DbClient/StorageClient
// instances, which derive their PG JWT from JWT_SECRET.
process.env.JWT_SECRET ??= "test-secret";

// The core no longer constructs the SaaS billing client: the composition root
// injects the port. This suite only drives setByokTurnContext, so billing is a
// stub that fails loudly if a test ever reaches a billable path.
const testBilling: TurnUsageBilling = {
  createPricingQuote: async () => {
    throw new Error("unexpected createPricingQuote call in a byok state test");
  },
  recordAndChargeQuotedUsage: async () => {},
  recordByokUsage: async () => {},
};

function makeOrchestrator(
  config: Omit<NovelOrchestratorConfig, "billing" | "entitlements">,
): NovelOrchestrator {
  return new NovelOrchestrator({
    ...config,
    billing: testBilling,
    entitlements: ALLOW_ALL_ENTITLEMENTS,
  });
}

describe("NovelOrchestrator byok turn state", () => {
  it("mirrors the turn key into the shared state slot and clears it", () => {
    const state: ByokTurnState = { apiKey: null };
    const orchestrator = makeOrchestrator({ token: "t", projectId: "p", byokTurnState: state });
    orchestrator.setByokTurnContext({ apiKey: "sk-live" });
    expect(state.apiKey).toBe("sk-live");
    orchestrator.setByokTurnContext(null);
    expect(state.apiKey).toBeNull();
  });

  it("stays inert without a shared state slot", () => {
    const orchestrator = makeOrchestrator({ token: "t", projectId: "p" });
    expect(() => orchestrator.setByokTurnContext({ apiKey: "sk-x" })).not.toThrow();
  });
});
