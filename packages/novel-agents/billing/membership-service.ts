import type { DbClient } from "../lib/db.js";
import {
  buildPayUrl,
  generateOutTradeNo,
  getZpayKey,
  getZpayPid,
  isZPayConfigured,
  parseNotification,
  verifySign,
} from "../lib/zpay.js";
import { PaymentError } from "./payment-service.js";

export interface MembershipPlanView {
  id: string;
  slug: string;
  name: string;
  priceCents: number;
  durationDays: number;
  bonusCredits: number;
  features: string[];
}

export interface MembershipStatusView {
  active: boolean;
  planName: string | null;
  expiresAt: string | null;
  features: string[];
}

export class MembershipService {
  constructor(private readonly db: Pick<DbClient,
    "listMembershipPlans" | "createMembershipPurchase" | "getMembershipPurchase"
    | "completeMembershipPurchase" | "getActiveMembership"
  >) {}

  async listPlans(): Promise<MembershipPlanView[]> {
    const rows = await this.db.listMembershipPlans();
    return rows.map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      priceCents: Number(row.price_cents),
      durationDays: Number(row.duration_days),
      bonusCredits: Number(row.bonus_credits ?? 0),
      features: Array.isArray(row.features) ? row.features : [],
    }));
  }

  async getStatus(userId: string): Promise<MembershipStatusView> {
    const row = await this.db.getActiveMembership(userId);
    if (!row || !row.active) {
      return { active: false, planName: null, expiresAt: null, features: [] };
    }
    return {
      active: true,
      planName: row.plan_name ?? null,
      expiresAt: row.expires_at ?? null,
      features: Array.isArray(row.features) ? row.features : [],
    };
  }

  async createPurchase(userId: string, planId: string): Promise<{ orderNo: string; payUrl: string }> {
    const plans = await this.db.listMembershipPlans();
    const selected = plans.find((item) => String(item.id) === planId && item.is_active !== false);
    if (!selected) throw new PaymentError("会员套餐不存在或已停用", 404);
    if (!isZPayConfigured()) throw new PaymentError("支付服务暂不可用", 503);
    const orderNo = generateOutTradeNo("membership");
    const priceCents = Number(selected.price_cents);
    const features = Array.isArray(selected.features) ? selected.features : [];
    await this.db.createMembershipPurchase({
      userId, outTradeNo: orderNo, planId, planName: String(selected.name),
      priceCents, durationDays: Number(selected.duration_days),
      bonusCredits: Number(selected.bonus_credits ?? 0), features,
    });
    return {
      orderNo,
      payUrl: buildPayUrl({
        outTradeNo: orderNo, name: String(selected.name),
        money: (priceCents / 100).toFixed(2), userId,
      }),
    };
  }

  async getPurchase(userId: string, orderNo: string): Promise<{ orderNo: string; status: string }> {
    const purchase = await this.db.getMembershipPurchase(orderNo);
    if (!purchase || String(purchase.user_id) !== userId) throw new PaymentError("订单不存在", 404);
    return { orderNo: String(purchase.out_trade_no), status: String(purchase.payment_status) };
  }

  async handleNotification(params: URLSearchParams): Promise<"success"> {
    const notification = parseNotification(params);
    if (!notification) throw new PaymentError("支付通知字段不完整", 400);
    if (!isZPayConfigured() || !verifySign(Object.fromEntries(params), getZpayKey())) {
      throw new PaymentError("支付通知签名无效", 400);
    }
    if (notification.pid !== getZpayPid() || notification.trade_status !== "TRADE_SUCCESS") {
      throw new PaymentError("支付通知状态无效", 400);
    }
    const purchase = await this.db.getMembershipPurchase(notification.out_trade_no);
    if (!purchase || String(purchase.user_id) !== notification.param) throw new PaymentError("支付订单无效", 400);
    if (!/^\d+(?:\.\d{1,2})?$/.test(notification.money)
      || Math.round(Number(notification.money) * 100) !== Number(purchase.price_cents)) {
      throw new PaymentError("支付金额不匹配", 400);
    }
    await this.db.completeMembershipPurchase(notification.out_trade_no, notification.trade_no);
    return "success";
  }
}
