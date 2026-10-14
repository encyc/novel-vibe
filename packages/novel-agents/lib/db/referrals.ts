import type { DbRequestContext } from "./context.js";

async function referralRpc(ctx: DbRequestContext, name: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${ctx.pgUrl}/rpc/${name}`, {
    method: "POST",
    headers: ctx.headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} failed [${res.status}]: ${await res.text()}`);
  const payload = await res.json();
  return Array.isArray(payload) ? payload[0] ?? null : payload;
}

export async function previewReferralCode(ctx: DbRequestContext, code: string): Promise<Record<string, unknown> | null> {
  return referralRpc(ctx, "preview_referral_code", { p_code: code });
}

export async function getReferralDashboard(ctx: DbRequestContext, userId: string): Promise<Record<string, unknown> | null> {
  return referralRpc(ctx, "get_referral_dashboard", { p_user_id: userId });
}

export function updateReferralCampaign(
  ctx: DbRequestContext,
  input: { bindingEndsAt: string; adminUserId: string; reason: string },
) {
  return referralRpc(ctx, "update_referral_campaign", {
    p_binding_ends_at: input.bindingEndsAt,
    p_admin_user_id: input.adminUserId,
    p_reason: input.reason,
  });
}

export function getReferralAdminMetrics(ctx: DbRequestContext) {
  return referralRpc(ctx, "get_referral_admin_metrics");
}

export async function listReferralAdminBindings(
  ctx: DbRequestContext,
  input: { search?: string; cursor?: string; limit?: number },
): Promise<Record<string, unknown>[]> {
  const payload = await referralRpc(ctx, "list_referral_admin_bindings", {
    p_search: input.search ?? null,
    p_cursor: input.cursor ?? null,
    p_limit: input.limit ?? 50,
  });
  return Array.isArray(payload) ? payload : [];
}

export function reviewReferralBinding(
  ctx: DbRequestContext,
  input: { bindingId: string; decision: "approve" | "reject"; adminUserId: string; reason: string },
) {
  return referralRpc(ctx, "review_referral_binding", {
    p_binding_id: input.bindingId,
    p_decision: input.decision,
    p_admin_user_id: input.adminUserId,
    p_reason: input.reason,
  });
}
