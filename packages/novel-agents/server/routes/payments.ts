import { DbClient } from "../../lib/db.js";
import { MembershipService } from "../../billing/membership-service.js";
import { PaymentError, PaymentService } from "../../billing/payment-service.js";
import { parseBody } from "../http.js";
import { textResponse } from "../http.js";

import type { PublicRouteContext } from "../http.js";

export async function paymentsZpayNotifyPost({ req, res, url, path }: PublicRouteContext) {
  try {
    const raw = await parseBody(req);
    const params = new URLSearchParams(raw);
    const outTradeNo = params.get("out_trade_no") ?? "";
    // MC- prefix routes to membership completion; everything else stays on credit.
    const service = outTradeNo.startsWith("MC-")
      ? new MembershipService(DbClient.forSystem())
      : new PaymentService(DbClient.forSystem());
    const result = await service.handleNotification(params);
    textResponse(res, result);
  } catch (err) {
    const status = err instanceof PaymentError ? err.status : 500;
    textResponse(res, err instanceof Error ? err.message : "invalid callback", status);
  }
  return;

}
