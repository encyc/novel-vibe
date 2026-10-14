import type { DbRequestContext } from "./context.js";

export interface CreditActivityRow {
  activity_date: string;
  credits_consumed: number;
  total_tokens: number;
}

export interface CreditTransactionCursorRow {
  id: string;
  user_id: string;
  type: "consume" | "topup" | "grant";
  amount: number;
  balance_after: number;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function getCreditBalance(ctx: DbRequestContext, userId: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/credit_balances?user_id=eq.${userId}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get credit balance failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function createCreditBalance(ctx: DbRequestContext, userId: string, initialBalance: number): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/credit_balances`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        user_id: userId,
        balance: initialBalance,
        total_granted: initialBalance,
      }),
    });
    if (!res.ok) throw new Error(`Create credit balance failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }

export async function topUpCredits(ctx: DbRequestContext, userId: string, amount: number, description?: string, metadata?: Record<string, unknown>, type: "topup" | "grant" = "topup"): Promise<any> {
    const current = await getCreditBalance(ctx, userId);
    if (!current) throw new Error(`No credit balance found for user ${userId}`);

    const curBalance = Number(current.balance);
    const curGranted = Number(current.total_granted);
    const newBalance = curBalance + amount;

    const balRes = await fetch(`${ctx.pgUrl}/credit_balances?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({
        balance: newBalance,
        total_granted: curGranted + amount,
      }),
    });
    if (!balRes.ok) throw new Error(`Update credit balance failed [${balRes.status}]: ${await balRes.text()}`);

    const txnRes = await fetch(`${ctx.pgUrl}/credit_transactions`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        user_id: userId,
        type: type,
        amount,
        balance_after: newBalance,
        description: description ?? "Credit top-up",
        metadata: metadata ?? {},
      }),
    });
    if (!txnRes.ok) throw new Error(`Top-up transaction failed [${txnRes.status}]: ${await txnRes.text()}`);
    const rows = await txnRes.json();
    return rows[0];
  }

export async function deductCreditsAtomic(ctx: DbRequestContext, userId: string, amount: number, referenceType: string, referenceId: string, description: string, metadata?: Record<string, unknown>): Promise<{ success: boolean; new_balance: number }> {
    const res = await fetch(`${ctx.pgUrl}/rpc/deduct_credits`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_user_id: userId,
        p_amount: amount,
        p_reference_type: referenceType,
        p_reference_id: referenceId,
        p_description: description,
        p_metadata: metadata ?? {},
      }),
    });
    if (!res.ok) throw new Error(`Deduct credits failed [${res.status}]: ${await res.text()}`);
    // `novel.deduct_credits` is a RETURNS TABLE function, so PostgREST wraps its
    // single result row in an array. Returning that array verbatim made every
    // caller read `undefined` for `success`/`new_balance`, which logged a bogus
    // "insufficient balance" warning for charges that had actually succeeded.
    const body: unknown = await res.json();
    const row = (Array.isArray(body) ? body[0] : body) as
      | { success?: unknown; new_balance?: unknown }
      | undefined;
    if (!row || typeof row.success !== "boolean") {
      throw new Error(`Deduct credits returned an unexpected payload for user ${userId}`);
    }
    const newBalance = Number(row.new_balance);
    if (!Number.isFinite(newBalance)) {
      throw new Error(`Deduct credits returned an invalid balance for user ${userId}`);
    }
    return { success: row.success, new_balance: newBalance };
  }

export async function listCreditTransactions(ctx: DbRequestContext, userId: string, limit = 50, offset = 0): Promise<any[]> {
    const url = `${ctx.pgUrl}/credit_transactions?user_id=eq.${userId}&order=created_at.desc&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List transactions failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function listCreditTransactionsCursor(ctx: DbRequestContext, params: {
    userId: string;
    type: "consume" | "topup" | "grant";
    beforeCreatedAt?: string;
    beforeId?: string;
    limit?: number;
  }): Promise<CreditTransactionCursorRow[]> {
    const res = await fetch(`${ctx.pgUrl}/rpc/list_credit_transactions_cursor`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_user_id: params.userId,
        p_type: params.type,
        p_before_created_at: params.beforeCreatedAt ?? null,
        p_before_id: params.beforeId ?? null,
        p_limit: params.limit ?? 21,
      }),
    });
    if (!res.ok) throw new Error(`List transactions cursor failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function insertUsageRecord(ctx: DbRequestContext, params: {
    userId: string;
    projectId: string;
    sessionId?: string;
    agentId: string;
    modelId: string;
    modelProvider: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
    creditsConsumed: number;
    creditRateId?: string;
    requestStartedAt?: string;
    pricingPeriod?: string;
    creditRateWindowId?: string | null;
    contextTokens?: number;
    creditRateContextTierId?: string | null;
    rateSnapshot?: Record<string, unknown>;
    billingMultiplier?: number;
  }): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/usage_records`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        user_id: params.userId,
        project_id: params.projectId,
        session_id: params.sessionId ?? null,
        agent_id: params.agentId,
        model_id: params.modelId,
        model_provider: params.modelProvider,
        input_tokens: params.inputTokens,
        output_tokens: params.outputTokens,
        cache_read_tokens: params.cacheReadTokens,
        cache_write_tokens: params.cacheWriteTokens,
        total_tokens: params.totalTokens,
        cost_usd: params.costUsd,
        credits_consumed: params.creditsConsumed,
        credit_rate_id: params.creditRateId ?? null,
        request_started_at: params.requestStartedAt ?? null,
        pricing_period: params.pricingPeriod ?? null,
        credit_rate_window_id: params.creditRateWindowId ?? null,
        context_tokens: params.contextTokens ?? null,
        credit_rate_context_tier_id: params.creditRateContextTierId ?? null,
        rate_snapshot: params.rateSnapshot ?? null,
        billing_multiplier: params.billingMultiplier ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Insert usage record failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }

export async function listUsageRecords(ctx: DbRequestContext, userId: string, projectId?: string, limit = 50): Promise<any[]> {
    let url = `${ctx.pgUrl}/usage_records?user_id=eq.${userId}&order=created_at.desc&limit=${limit}`;
    if (projectId) url += `&project_id=eq.${projectId}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List usage records failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function getCreditActivity(ctx: DbRequestContext, params: {
    userId: string;
    year: number;
    timezone: string;
  }): Promise<CreditActivityRow[]> {
    const res = await fetch(`${ctx.pgUrl}/rpc/credit_activity_by_day`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_user_id: params.userId,
        p_year: params.year,
        p_timezone: params.timezone,
      }),
    });
    if (!res.ok) throw new Error(`Get credit activity failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function listCreditRates(ctx: DbRequestContext): Promise<any[]> {
    const url = `${ctx.pgUrl}/credit_rates?is_active=eq.true&order=priority.desc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List credit rates failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function listCreditRateTimeWindows(ctx: DbRequestContext): Promise<any[]> {
    const url = `${ctx.pgUrl}/credit_rate_time_windows?is_active=eq.true&order=priority.desc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List credit rate time windows failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function listCreditRateContextTiers(ctx: DbRequestContext): Promise<any[]> {
    const url = `${ctx.pgUrl}/credit_rate_context_tiers?is_active=eq.true&order=priority.desc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) {
      throw new Error(`List credit rate context tiers failed [${res.status}]: ${await res.text()}`);
    }
    return res.json();
  }

export async function upsertCreditRate(ctx: DbRequestContext, params: {
    name: string;
    modelPattern: string;
    providerPattern?: string;
    inputRate: number;
    outputRate: number;
    cacheReadRate: number;
    cacheWriteRate: number;
    priority?: number;
  }): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/credit_rates`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "resolution=merge-duplicates" }),
      body: JSON.stringify({
        name: params.name,
        model_pattern: params.modelPattern,
        provider_pattern: params.providerPattern ?? null,
        input_rate: params.inputRate,
        output_rate: params.outputRate,
        cache_read_rate: params.cacheReadRate,
        cache_write_rate: params.cacheWriteRate,
        priority: params.priority ?? 0,
      }),
    });
    if (!res.ok) throw new Error(`Upsert credit rate failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }
