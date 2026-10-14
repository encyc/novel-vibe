import type { DbRequestContext } from "./context.js";

export async function listMembershipPlans(ctx: DbRequestContext): Promise<any[]> {
    const url = `${ctx.pgUrl}/membership_plans?is_active=eq.true&order=display_order.asc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List membership plans failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function createMembershipPurchase(ctx: DbRequestContext, params: {
    userId: string;
    outTradeNo: string;
    planId: string;
    planName: string;
    priceCents: number;
    durationDays: number;
    bonusCredits: number;
    features: string[];
    source?: string;
  }): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/membership_purchases`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        user_id: params.userId,
        out_trade_no: params.outTradeNo,
        plan_id: params.planId,
        plan_name_snapshot: params.planName,
        price_cents: params.priceCents,
        duration_days_snapshot: params.durationDays,
        bonus_credits_snapshot: params.bonusCredits,
        features_snapshot: params.features,
        payment_provider: "zpay",
        payment_status: "pending",
        source: params.source ?? "purchase",
      }),
    });
    if (!res.ok) throw new Error(`Create membership purchase failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function getMembershipPurchase(ctx: DbRequestContext, outTradeNo: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/membership_purchases?out_trade_no=eq.${encodeURIComponent(outTradeNo)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get membership purchase failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function completeMembershipPurchase(ctx: DbRequestContext, outTradeNo: string, paymentId: string): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/rpc/complete_membership_purchase`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_out_trade_no: outTradeNo, p_payment_id: paymentId }),
    });
    if (!res.ok) throw new Error(`Complete membership purchase failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function getActiveMembership(ctx: DbRequestContext, userId: string): Promise<any | null> {
    const res = await fetch(`${ctx.pgUrl}/rpc/get_active_membership`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!res.ok) throw new Error(`Get active membership failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

/** Batch display-only lookup: which of these users hold an active membership. */
export async function getActiveMembershipUserIds(ctx: DbRequestContext, userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const res = await fetch(`${ctx.pgUrl}/rpc/get_active_membership_user_ids`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_user_ids: userIds }),
    });
    if (!res.ok) throw new Error(`Get active membership user ids failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json() as Array<{ user_id: string }>;
    return new Set(rows.map((row) => String(row.user_id)));
  }
