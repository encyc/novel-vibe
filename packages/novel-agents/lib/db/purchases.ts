import type { DbRequestContext } from "./context.js";

export async function createPurchase(ctx: DbRequestContext, params: {
    userId: string;
    outTradeNo: string;
    packageId: string;
    packageName: string;
    credits: number;
    bonusCredits: number;
    priceCents: number;
  }): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/credit_purchases`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        user_id: params.userId,
        out_trade_no: params.outTradeNo,
        package_id: params.packageId,
        package_name_snapshot: params.packageName,
        credits: params.credits,
        bonus_credits_snapshot: params.bonusCredits,
        price_cents: params.priceCents,
        payment_provider: "zpay",
        payment_status: "pending",
      }),
    });
    if (!res.ok) throw new Error(`Create purchase failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function getPurchase(ctx: DbRequestContext, outTradeNo: string): Promise<any | null> {
    const url = `${ctx.pgUrl}/credit_purchases?out_trade_no=eq.${encodeURIComponent(outTradeNo)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get purchase failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function updatePurchaseCompleted(ctx: DbRequestContext, outTradeNo: string, paymentId: string): Promise<void> {
    const url = `${ctx.pgUrl}/credit_purchases?out_trade_no=eq.${encodeURIComponent(outTradeNo)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({
        payment_status: "completed",
        payment_id: paymentId,
        completed_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`Update purchase failed [${res.status}]: ${await res.text()}`);
  }

export async function completeCreditPurchase(ctx: DbRequestContext, outTradeNo: string, paymentId: string): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/rpc/complete_credit_purchase`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_out_trade_no: outTradeNo, p_payment_id: paymentId }),
    });
    if (!res.ok) throw new Error(`Complete purchase failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function listCreditPackages(ctx: DbRequestContext): Promise<any[]> {
    const url = `${ctx.pgUrl}/credit_packages?is_active=eq.true&order=display_order.asc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List packages failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }
