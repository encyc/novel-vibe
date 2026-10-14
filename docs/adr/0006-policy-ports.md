# ADR 0006: Policy Ports — Entitlements and Usage Billing

- **Status:** Accepted
- **Date:** 2026-10-10
- **Scope:** `packages/novel-agents/lib/policy-ports.ts` and its consumers
- **Related:** ADR 0005 (ContentStore port), `docs/plans/2026-10-10-phase0-1-closeout.md`（私有运维仓）

## Context

The architecture boundary check (`scripts/check-architecture-boundary.mjs`) enforces
one rule: **the creation core must not import SaaS modules.** After the Phase 0/1
close-out it reported exactly seven remaining violations, all runtime edges, all in
the same shape — the core reaching for a *decision that belongs to the SaaS layer*:

| Where | Reaches for | Why |
|---|---|---|
| `agents.ts` | `lib/credits.ts`, `lib/usage-tracker.ts` | constructs `CreditBillingClient` to price and charge turns |
| `server/routes/chat.ts` | `lib/credits.ts`, `billing/entitlements.ts` | pre-flight balance gate + premium/BYOK membership gate |
| `server/routes/documents.ts` | `billing/entitlements.ts` | export entitlement |
| `server/routes/projects.ts` | `billing/entitlements.ts` | unlimited-projects entitlement |
| `tools/web-tools.ts` | `billing/entitlements.ts` | `web_search` entitlement |

These cannot be fixed by moving imports around. The core genuinely needs to ask
"may this user do X?" and "bill this usage" — what it must not need is *how* the
answer is computed, or from which tables.

They also cannot be deleted for a local-first build: a self-hosting user owns the
software, so the honest local answer is "yes" to every entitlement, and their own
model key pays the provider, so there is nothing to charge. Deleting the gate would
change hosted behaviour; keeping it inline prevents local mode from existing.

## Decision

**Define the two decisions the core makes as ports it owns, and let the SaaS layer
implement them.**

1. `lib/policy-ports.ts` (core) declares:
   - `CoreEntitlement` — a deliberately **closed, small** union naming only the
     entitlements the core actually branches on (`byok`, `premium_models`,
     `export`, `unlimited_projects`, `web_search`). It is *not* a mirror of the SaaS
     membership catalog; `billing/entitlements.ts` keeps its own broader key set.
   - `EntitlementPort` — `has(userId, entitlement): Promise<boolean>`.
   - `ALLOW_ALL_ENTITLEMENTS` — the local-first implementation.
   - `TurnUsageBilling` — the three billing operations the turn runtime performs
     (`createPricingQuote`, `recordAndChargeQuotedUsage`, `recordByokUsage`).
2. **`UsageRecordParams` moves into the core** (`lib/usage-cost-types.ts`), because
   `TurnUsageBilling` is described in terms of it. `lib/credits.ts` re-exports it,
   so every existing import path keeps resolving — the same technique ADR 0005 used
   for `sha256Content` and the same one the shared usage/pricing types already follow.
3. **Ports are structural, not nominal.** The core never imports the implementation;
   the SaaS adapter proves conformance at compile time instead.
4. **The composition root injects the implementations.** `server.ts` and
   `server/runtime.ts` are already exempt from the boundary rule precisely because
   they must know every implementation, so they construct the credit client and the
   entitlement adapter and hand them to the core.
5. **`server/http.ts`'s `RouteContext` carries the port, not the service.** Core
   route handlers depend on `entitlements()`, while the SaaS handlers keep using
   `membershipService()` — `RouteContext` exposes both because it is the composition
   root's type surface.
6. **`lib/usage-tracker.ts` becomes core.** Its only SaaS dependency was a
   `Pick<CreditBillingClient, …>` type for its `billing` parameter; with that replaced
   by `TurnUsageBilling`, and its `PricingQuote` import repointed at
   `usage-cost-types.js`, the file imports no SaaS module at all. Metering *when* a
   turn is billed is a core concern; computing *what* it costs is not.

## Consequences

- `--enforce` becomes satisfiable: the domain violation count reaches zero, and the
  rule starts guarding the property it was written to guard rather than a list of
  known exceptions.
- A local-first build can supply `ALLOW_ALL_ENTITLEMENTS` and a non-charging billing
  implementation without linking credits, pricing or membership at all. Wiring that
  is Phase 3 work; this ADR makes it possible.
- The feature vocabulary is now duplicated in two places on purpose: the core's
  closed `CoreEntitlement` union and the SaaS catalog. They are bridged by one
  explicit `Record<CoreEntitlement, MembershipFeatureKey>` in the adapter, so a
  catalog rename is a one-line change and a *new* core gate forces a deliberate
  edit to the union.
- Behaviour must be preserved exactly, including the distinction between "not
  entitled" and "entitlement lookup failed" — `tools/web-tools.ts` reports those as
  different errors, so the adapter must let lookup failures propagate rather than
  swallowing them into `false`.

## Note on layering

This ADR does not claim the core is free of SaaS *semantics* — it still contains
gates, error messages and a premium-model notion. What it no longer contains is a
SaaS *dependency*. Removing the semantics themselves would change product
behaviour and is explicitly out of scope.
