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

export class PaymentError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface CreditPackageView {
  id: string;
  name: string;
  priceCents: number;
  credits: number;
  bonusCredits: number;
}

export class PaymentService {
  constructor(private readonly db: Pick<DbClient,
    "listCreditPackages" | "createPurchase" | "getPurchase" | "completeCreditPurchase"
  >) {}

  async listPackages(): Promise<CreditPackageView[]> {
    const rows = await this.db.listCreditPackages();
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), priceCents: Number(row.price_cents),
      credits: Number(row.credits), bonusCredits: Number(row.bonus_credits ?? 0),
    }));
  }

  async createPurchase(userId: string, packageId: string): Promise<{ orderNo: string; payUrl: string }> {
    const packages = await this.db.listCreditPackages();
    const selected = packages.find((item) => String(item.id) === packageId && item.is_active !== false);
    if (!selected) throw new PaymentError("充值套餐不存在或已停用", 404);
    if (!isZPayConfigured()) throw new PaymentError("支付服务暂不可用", 503);
    const orderNo = generateOutTradeNo();
    const credits = Number(selected.credits);
    const bonusCredits = Number(selected.bonus_credits ?? 0);
    const priceCents = Number(selected.price_cents);
    await this.db.createPurchase({
      userId, outTradeNo: orderNo, packageId, packageName: String(selected.name),
      credits, bonusCredits, priceCents,
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
    const purchase = await this.db.getPurchase(orderNo);
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
    const purchase = await this.db.getPurchase(notification.out_trade_no);
    if (!purchase || String(purchase.user_id) !== notification.param) throw new PaymentError("支付订单无效", 400);
    if (!/^\d+(?:\.\d{1,2})?$/.test(notification.money)
      || Math.round(Number(notification.money) * 100) !== Number(purchase.price_cents)) {
      throw new PaymentError("支付金额不匹配", 400);
    }
    await this.db.completeCreditPurchase(notification.out_trade_no, notification.trade_no);
    return "success";
  }
}
