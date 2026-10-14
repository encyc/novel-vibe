import type { PoolClient } from "pg";
import type {
  CatalogContextTier,
  CatalogTimeWindow,
  OpenCodeCandidate,
  TokenRates,
} from "./opencode-source.js";
import type {
  RuntimeModelApi,
  RuntimeModelSource,
  RuntimeModelStatus,
} from "../model-runtime/types.js";

const OFFICIAL_USD_TO_CREDITS_PER_THOUSAND = 0.07;

export interface CurrentCreditRate {
  id: string;
  name: string;
  modelId: string;
  providerPattern: string | null;
  rates: TokenRates;
  priority: number;
  isActive: boolean;
}

export interface CurrentTimeWindow extends CatalogTimeWindow {
  id: string;
  creditRateId: string;
}

export interface CurrentContextTier extends CatalogContextTier {
  id: string;
  creditRateId: string;
  creditRateTimeWindowId: string | null;
}

export interface CurrentCatalogState {
  rates: CurrentCreditRate[];
  timeWindows: CurrentTimeWindow[];
  contextTiers: CurrentContextTier[];
  runtimes: CurrentRuntimeModel[];
}

export interface CurrentRuntimeModel {
  id: string;
  provider: string;
  modelId: string;
  source: RuntimeModelSource;
  runtimeFingerprint: string;
  status: RuntimeModelStatus;
}

export interface CatalogRuntimeUpsert {
  existingRuntimeId: string | null;
  provider: "opencode";
  modelId: string;
  name: string;
  api: RuntimeModelApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  inputModalities: string[];
  source: RuntimeModelSource;
  runtimeFingerprint: string;
  sourceHashes: OpenCodeCandidate["sourceHashes"];
  status: "active";
}

export interface CatalogUpsert {
  existingRateId: string | null;
  modelId: string;
  name: string;
  rates: TokenRates;
  priority: number;
  timeWindows: CatalogTimeWindow[];
  contextTiers: CatalogContextTier[];
  replaceTimeWindows: boolean;
  replaceContextTiers: boolean;
}

export type CatalogChangeKind =
  | "added"
  | "activated"
  | "deactivated"
  | "price_updated"
  | "peak_updated"
  | "context_tiers_updated"
  | "unsupported_observed"
  | "dynamic_discovered"
  | "dynamic_activated"
  | "dynamic_reenabled"
  | "dynamic_retired"
  | "unsupported_endpoint";

export interface CatalogChange {
  kind: CatalogChangeKind;
  modelId: string;
  before?: unknown;
  after?: unknown;
}

export interface CatalogChangeSet {
  runtimeUpserts: CatalogRuntimeUpsert[];
  retireRuntimeIds: string[];
  upserts: CatalogUpsert[];
  deactivateRateIds: string[];
  changes: CatalogChange[];
  report: {
    unsupportedEndpointModelIds: string[];
    unsupportedModelIds: string[];
    unpricedRuntimeModelIds: string[];
    disabledRuntimeModelIds: string[];
    preservedWildcardModelIds: string[];
  };
}

function roundRate(value: number): number {
  return Number(value.toFixed(6));
}

export function convertOfficialRates(rates: TokenRates): TokenRates {
  return {
    input: roundRate(rates.input * OFFICIAL_USD_TO_CREDITS_PER_THOUSAND),
    output: roundRate(rates.output * OFFICIAL_USD_TO_CREDITS_PER_THOUSAND),
    cacheRead: roundRate(rates.cacheRead * OFFICIAL_USD_TO_CREDITS_PER_THOUSAND),
    cacheWrite: roundRate(rates.cacheWrite * OFFICIAL_USD_TO_CREDITS_PER_THOUSAND),
  };
}

function sameRates(left: TokenRates, right: TokenRates): boolean {
  return left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite;
}

function windowComparable(window: CatalogTimeWindow): object {
  return {
    label: window.label,
    startMinuteUtc: window.startMinuteUtc,
    endMinuteUtc: window.endMinuteUtc,
    rates: window.rates,
  };
}

function tierComparable(tier: CatalogContextTier): object {
  return {
    label: tier.label,
    minContextTokens: tier.minContextTokens,
    maxContextTokens: tier.maxContextTokens,
    rates: tier.rates,
  };
}

function sameCollection(left: object[], right: object[]): boolean {
  const normalize = (values: object[]) => values.map((value) => JSON.stringify(value)).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function hasWildcard(modelPattern: string): boolean {
  return modelPattern.includes("%") || modelPattern.includes("_");
}

export function buildCatalogChangeSet(
  candidate: OpenCodeCandidate,
  current: CurrentCatalogState,
): CatalogChangeSet {
  const exactRates = current.rates.filter((rate) =>
    rate.providerPattern === "opencode" && !hasWildcard(rate.modelId));
  const currentByModelId = new Map<string, CurrentCreditRate>();
  for (const rate of exactRates) {
    if (currentByModelId.has(rate.modelId)) {
      throw new Error(`Duplicate exact OpenCode credit rate: ${rate.modelId}`);
    }
    currentByModelId.set(rate.modelId, rate);
  }

  const currentRuntimeByModelId = new Map<string, CurrentRuntimeModel>();
  for (const runtime of current.runtimes) {
    if (runtime.provider !== "opencode") continue;
    if (currentRuntimeByModelId.has(runtime.modelId)) {
      throw new Error(`Duplicate OpenCode runtime model: ${runtime.modelId}`);
    }
    currentRuntimeByModelId.set(runtime.modelId, runtime);
  }

  const desiredIds = new Set<string>();
  const runtimeUpserts: CatalogRuntimeUpsert[] = [];
  const disabledRuntimeModelIds: string[] = [];
  const upserts: CatalogUpsert[] = [];
  const changes: CatalogChange[] = [];
  for (const model of candidate.models) {
    const existingRuntime = currentRuntimeByModelId.get(model.id);
    const matchingDisabledFingerprint = existingRuntime?.status === "disabled"
      && existingRuntime.runtimeFingerprint === model.runtime.runtimeFingerprint
      && model.runtime.source === "opencode-dynamic";
    if (matchingDisabledFingerprint) {
      disabledRuntimeModelIds.push(model.id);
      continue;
    }

    desiredIds.add(model.id);
    const runtimeChanged = !existingRuntime
      || existingRuntime.runtimeFingerprint !== model.runtime.runtimeFingerprint
      || existingRuntime.source !== model.runtime.source
      || existingRuntime.status !== "active";
    if (runtimeChanged) {
      runtimeUpserts.push({
        existingRuntimeId: existingRuntime?.id ?? null,
        provider: "opencode",
        modelId: model.id,
        name: model.name,
        api: model.runtime.api,
        baseUrl: model.runtime.baseUrl,
        contextWindow: model.runtime.contextWindow,
        maxTokens: model.runtime.maxTokens,
        reasoning: model.runtime.reasoning,
        inputModalities: [...model.runtime.inputModalities],
        source: model.runtime.source,
        runtimeFingerprint: model.runtime.runtimeFingerprint,
        sourceHashes: candidate.sourceHashes,
        status: "active",
      });
      if (!existingRuntime && model.runtime.source === "opencode-dynamic") {
        changes.push({ kind: "dynamic_discovered", modelId: model.id });
        changes.push({ kind: "dynamic_activated", modelId: model.id });
      } else if (existingRuntime && existingRuntime.status !== "active") {
        changes.push({ kind: "dynamic_reenabled", modelId: model.id });
      }
    }

    const rates = convertOfficialRates(model.baseRates);
    const timeWindows = model.timeWindows.map((window) => ({
      ...window,
      rates: convertOfficialRates(window.rates),
    }));
    const contextTiers = model.contextTiers.map((tier) => ({
      ...tier,
      rates: convertOfficialRates(tier.rates),
    }));
    const existing = currentByModelId.get(model.id);
    if (!existing) {
      upserts.push({
        existingRateId: null,
        modelId: model.id,
        name: model.name,
        rates,
        priority: 50,
        timeWindows,
        contextTiers,
        replaceTimeWindows: true,
        replaceContextTiers: true,
      });
      changes.push({ kind: "added", modelId: model.id, after: rates });
      continue;
    }

    const currentWindows = current.timeWindows
      .filter((window) => window.creditRateId === existing.id)
      .map(windowComparable);
    const currentTiers = current.contextTiers
      .filter((tier) => tier.creditRateId === existing.id && tier.creditRateTimeWindowId === null)
      .map(tierComparable);
    const replaceTimeWindows = !sameCollection(currentWindows, timeWindows.map(windowComparable));
    const replaceContextTiers = !sameCollection(currentTiers, contextTiers.map(tierComparable));
    const priceChanged = !sameRates(existing.rates, rates);
    const metadataChanged = existing.name !== model.name || existing.priority !== 50;
    const activate = !existing.isActive;
    if (activate) changes.push({ kind: "activated", modelId: model.id });
    if (priceChanged) {
      changes.push({ kind: "price_updated", modelId: model.id, before: existing.rates, after: rates });
    }
    if (replaceTimeWindows) changes.push({ kind: "peak_updated", modelId: model.id });
    if (replaceContextTiers) changes.push({ kind: "context_tiers_updated", modelId: model.id });
    if (activate || priceChanged || metadataChanged || replaceTimeWindows || replaceContextTiers) {
      upserts.push({
        existingRateId: existing.id,
        modelId: model.id,
        name: model.name,
        rates,
        priority: 50,
        timeWindows,
        contextTiers,
        replaceTimeWindows,
        replaceContextTiers,
      });
    }
  }

  const retireRuntimeIds: string[] = [];
  for (const runtime of current.runtimes) {
    if (runtime.provider === "opencode" && runtime.status === "active" && !desiredIds.has(runtime.modelId)) {
      retireRuntimeIds.push(runtime.id);
      changes.push({ kind: "dynamic_retired", modelId: runtime.modelId });
    }
  }

  const deactivateRateIds: string[] = [];
  for (const rate of exactRates) {
    if (rate.isActive && !desiredIds.has(rate.modelId)) {
      deactivateRateIds.push(rate.id);
      changes.push({ kind: "deactivated", modelId: rate.modelId });
    }
  }

  return {
    runtimeUpserts,
    retireRuntimeIds,
    upserts,
    deactivateRateIds,
    changes,
    report: {
      unsupportedEndpointModelIds: [...candidate.unsupportedEndpointModelIds],
      unsupportedModelIds: [...candidate.unsupportedEndpointModelIds],
      unpricedRuntimeModelIds: [...candidate.unpricedRuntimeModelIds],
      disabledRuntimeModelIds,
      preservedWildcardModelIds: current.rates
        .filter((rate) => rate.providerPattern === "opencode" && hasWildcard(rate.modelId))
        .map((rate) => rate.modelId)
        .sort(),
    },
  };
}

function rowRates(row: Record<string, unknown>): TokenRates {
  return {
    input: Number(row.input_rate),
    output: Number(row.output_rate),
    cacheRead: Number(row.cache_read_rate),
    cacheWrite: Number(row.cache_write_rate),
  };
}

export async function loadOpenCodeCatalogState(client: PoolClient): Promise<CurrentCatalogState> {
  const runtimesResult = await client.query(`
    SELECT id, provider, model_id, source, runtime_fingerprint, status
    FROM novel.model_runtime_catalog
    WHERE provider = 'opencode'
    ORDER BY model_id, id
  `);
  const runtimes: CurrentRuntimeModel[] = runtimesResult.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    source: row.source,
    runtimeFingerprint: row.runtime_fingerprint,
    status: row.status,
  }));
  const ratesResult = await client.query(`
    SELECT id, name, model_pattern, provider_pattern,
           input_rate, output_rate, cache_read_rate, cache_write_rate,
           priority, is_active
    FROM novel.credit_rates
    WHERE provider_pattern = 'opencode'
    ORDER BY model_pattern, id
  `);
  const rates: CurrentCreditRate[] = ratesResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    modelId: row.model_pattern,
    providerPattern: row.provider_pattern,
    rates: rowRates(row),
    priority: row.priority,
    isActive: row.is_active,
  }));
  const ids = rates.map((rate) => rate.id);
  if (ids.length === 0) return { rates, timeWindows: [], contextTiers: [], runtimes };

  const [windowsResult, tiersResult] = await Promise.all([
    client.query(`
      SELECT id, credit_rate_id, label, start_minute, end_minute,
             input_rate, output_rate, cache_read_rate, cache_write_rate
      FROM novel.credit_rate_time_windows
      WHERE credit_rate_id = ANY($1::uuid[])
        AND is_active = true
      ORDER BY credit_rate_id, start_minute, end_minute, id
    `, [ids]),
    client.query(`
      SELECT id, credit_rate_id, credit_rate_time_window_id, label,
             min_context_tokens, max_context_tokens,
             input_rate, output_rate, cache_read_rate, cache_write_rate
      FROM novel.credit_rate_context_tiers
      WHERE credit_rate_id = ANY($1::uuid[])
        AND is_active = true
      ORDER BY credit_rate_id, min_context_tokens, id
    `, [ids]),
  ]);
  return {
    rates,
    timeWindows: windowsResult.rows.map((row) => ({
      id: row.id,
      creditRateId: row.credit_rate_id,
      label: row.label,
      startMinuteUtc: row.start_minute,
      endMinuteUtc: row.end_minute,
      rates: rowRates(row),
    })),
    contextTiers: tiersResult.rows.map((row) => ({
      id: row.id,
      creditRateId: row.credit_rate_id,
      creditRateTimeWindowId: row.credit_rate_time_window_id,
      label: row.label,
      minContextTokens: Number(row.min_context_tokens),
      maxContextTokens: row.max_context_tokens === null ? null : Number(row.max_context_tokens),
      rates: rowRates(row),
    })),
    runtimes,
  };
}

export async function applyCatalogChangeSet(
  client: PoolClient,
  changeSet: CatalogChangeSet,
): Promise<void> {
  for (const runtime of changeSet.runtimeUpserts) {
    await client.query(`
      INSERT INTO novel.model_runtime_catalog (
        provider, model_id, name, api, base_url, context_window, max_tokens,
        reasoning, input_modalities, source, runtime_fingerprint, source_hashes,
        status, disabled_reason, disabled_at, last_seen_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12::jsonb,
        'active', NULL, NULL, now()
      )
      ON CONFLICT (provider, model_id) DO UPDATE SET
        name = EXCLUDED.name,
        api = EXCLUDED.api,
        base_url = EXCLUDED.base_url,
        context_window = EXCLUDED.context_window,
        max_tokens = EXCLUDED.max_tokens,
        reasoning = EXCLUDED.reasoning,
        input_modalities = EXCLUDED.input_modalities,
        source = EXCLUDED.source,
        runtime_fingerprint = EXCLUDED.runtime_fingerprint,
        source_hashes = EXCLUDED.source_hashes,
        status = 'active',
        disabled_reason = NULL,
        disabled_at = NULL,
        last_seen_at = now(),
        updated_at = now()
    `, [
      runtime.provider, runtime.modelId, runtime.name, runtime.api, runtime.baseUrl,
      runtime.contextWindow, runtime.maxTokens, runtime.reasoning, runtime.inputModalities,
      runtime.source, runtime.runtimeFingerprint, JSON.stringify(runtime.sourceHashes),
    ]);
  }

  if (changeSet.retireRuntimeIds.length > 0) {
    await client.query(`
      UPDATE novel.model_runtime_catalog
      SET status = 'retired', disabled_reason = NULL, disabled_at = NULL, updated_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'active'
    `, [changeSet.retireRuntimeIds]);
  }

  for (const mutation of changeSet.upserts) {
    let rateId = mutation.existingRateId;
    const parameters = [
      mutation.name,
      mutation.modelId,
      mutation.rates.input,
      mutation.rates.output,
      mutation.rates.cacheRead,
      mutation.rates.cacheWrite,
      mutation.priority,
    ];
    if (rateId) {
      await client.query(`
        UPDATE novel.credit_rates
        SET name = $1, model_pattern = $2, provider_pattern = 'opencode',
            input_rate = $3, output_rate = $4, cache_read_rate = $5,
            cache_write_rate = $6, priority = $7, is_active = true, updated_at = now()
        WHERE id = $8
      `, [...parameters, rateId]);
    } else {
      const inserted = await client.query(`
        INSERT INTO novel.credit_rates (
          name, model_pattern, provider_pattern,
          input_rate, output_rate, cache_read_rate, cache_write_rate,
          priority, is_active
        ) VALUES ($1, $2, 'opencode', $3, $4, $5, $6, $7, true)
        RETURNING id
      `, parameters);
      rateId = inserted.rows[0]?.id;
      if (!rateId) throw new Error(`Failed to insert OpenCode credit rate: ${mutation.modelId}`);
    }

    const replaceSpecialPricing = mutation.replaceContextTiers || mutation.replaceTimeWindows;
    if (replaceSpecialPricing) {
      await client.query("DELETE FROM novel.credit_rate_context_tiers WHERE credit_rate_id = $1", [rateId]);
      await client.query("DELETE FROM novel.credit_rate_time_windows WHERE credit_rate_id = $1", [rateId]);
      for (const window of mutation.timeWindows) {
        await client.query(`
          INSERT INTO novel.credit_rate_time_windows (
            credit_rate_id, label, timezone, start_minute, end_minute,
            input_rate, output_rate, cache_read_rate, cache_write_rate,
            priority, is_active
          ) VALUES ($1, $2, 'UTC', $3, $4, $5, $6, $7, $8, 100, true)
        `, [
          rateId, window.label, window.startMinuteUtc, window.endMinuteUtc,
          window.rates.input, window.rates.output,
          window.rates.cacheRead, window.rates.cacheWrite,
        ]);
      }
      for (const tier of mutation.contextTiers) {
        await client.query(`
          INSERT INTO novel.credit_rate_context_tiers (
            credit_rate_id, credit_rate_time_window_id, label,
            min_context_tokens, max_context_tokens,
            input_rate, output_rate, cache_read_rate, cache_write_rate,
            priority, is_active
          ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 100, true)
        `, [
          rateId, tier.label, tier.minContextTokens, tier.maxContextTokens,
          tier.rates.input, tier.rates.output,
          tier.rates.cacheRead, tier.rates.cacheWrite,
        ]);
      }
    }
  }

  if (changeSet.deactivateRateIds.length > 0) {
    await client.query(`
      UPDATE novel.credit_rate_context_tiers
      SET is_active = false, updated_at = now()
      WHERE credit_rate_id = ANY($1::uuid[]) AND is_active = true
    `, [changeSet.deactivateRateIds]);
    await client.query(`
      UPDATE novel.credit_rate_time_windows
      SET is_active = false, updated_at = now()
      WHERE credit_rate_id = ANY($1::uuid[]) AND is_active = true
    `, [changeSet.deactivateRateIds]);
    await client.query(`
      UPDATE novel.credit_rates
      SET is_active = false, updated_at = now()
      WHERE id = ANY($1::uuid[])
    `, [changeSet.deactivateRateIds]);
  }
}

export async function reenableOpenCodeModel(
  client: PoolClient,
  candidate: OpenCodeCandidate,
  modelId: string,
  recipient: string,
): Promise<boolean> {
  const model = candidate.models.find((entry) => entry.id === modelId);
  if (!model || model.runtime.source !== "opencode-dynamic") {
    throw new Error(`OpenCode model is not an activatable dynamic candidate: ${modelId}`);
  }

  const transitioned = await client.query(`
    UPDATE novel.model_runtime_catalog AS runtime
    SET name = $1,
        api = $2,
        base_url = $3,
        context_window = $4,
        max_tokens = $5,
        reasoning = $6,
        input_modalities = $7::text[],
        source_hashes = $8::jsonb,
        status = 'active',
        disabled_reason = NULL,
        disabled_at = NULL,
        last_seen_at = now(),
        updated_at = now()
    WHERE runtime.provider = 'opencode'
      AND runtime.model_id = $9
      AND runtime.source = 'opencode-dynamic'
      AND runtime.runtime_fingerprint = $10
      AND runtime.status = 'disabled'
    RETURNING runtime.id
  `, [
    model.name, model.runtime.api, model.runtime.baseUrl,
    model.runtime.contextWindow, model.runtime.maxTokens, model.runtime.reasoning,
    model.runtime.inputModalities, JSON.stringify(candidate.sourceHashes),
    model.id, model.runtime.runtimeFingerprint,
  ]);
  if (!transitioned.rows[0]?.id) return false;

  const state = await loadOpenCodeCatalogState(client);
  const scopedRateIds = new Set(state.rates
    .filter((rate) => rate.modelId === modelId || hasWildcard(rate.modelId))
    .map((rate) => rate.id));
  const scopedState: CurrentCatalogState = {
    rates: state.rates.filter((rate) => scopedRateIds.has(rate.id)),
    timeWindows: state.timeWindows.filter((window) => scopedRateIds.has(window.creditRateId)),
    contextTiers: state.contextTiers.filter((tier) => scopedRateIds.has(tier.creditRateId)),
    runtimes: state.runtimes.filter((runtime) => runtime.modelId === modelId),
  };
  const scopedCandidate: OpenCodeCandidate = {
    ...candidate,
    observedModelIds: [modelId],
    unsupportedEndpointModelIds: [],
    unsupportedModelIds: [],
    unpricedRuntimeModelIds: [],
    models: [model],
  };
  const changeSet = buildCatalogChangeSet(scopedCandidate, scopedState);
  await applyCatalogChangeSet(client, changeSet);

  await client.query(`
    INSERT INTO novel.system_email_outbox (recipient, subject, text_body)
    VALUES ($1, $2, $3)
  `, [
    recipient,
    `[Novel Vibe] Dynamic model re-enabled: ${modelId}`,
    `OpenCode dynamic model ${modelId} was manually re-enabled after its current runtime fingerprint was validated.`,
  ]);
  return true;
}
