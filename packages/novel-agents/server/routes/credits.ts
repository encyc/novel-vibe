import { CreditBillingClient } from "../../lib/credits.js";
import { DbClient } from "../../lib/db.js";
import { errorResponse } from "../http.js";
import { jsonResponse } from "../http.js";
import { parseBody } from "../http.js";

import type { RouteContext } from "../http.js";

export async function creditsSummaryGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const db = DbClient.forUser(token);
  const balance = await db.getCreditBalance(userId);
  const level = Number(balance?.level ?? 0);
  let levelName = "新用户";
  if (balance) {
    const levelConfig = await db.getLevelConfig(level);
    if (levelConfig?.name) levelName = String(levelConfig.name);
  }
  jsonResponse(res, {
    balance: Number(balance?.balance ?? 0),
    totalGranted: Number(balance?.total_granted ?? 0),
    totalConsumed: Number(balance?.total_consumed ?? 0),
    level,
    levelName,
  });
  return;

}

export async function creditsActivityGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const year = Number(url.searchParams.get("year"));
  const timezone = url.searchParams.get("timezone") ?? "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch {
    errorResponse(res, 400, "INVALID_TIMEZONE", "Invalid timezone"); return;
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    errorResponse(res, 400, "INVALID_YEAR", "Invalid year"); return;
  }
  const rows = await DbClient.forUser(token).getCreditActivity({ userId, year, timezone });
  jsonResponse(res, { days: rows.map((row) => ({ date: row.activity_date, creditsConsumed: Number(row.credits_consumed), totalTokens: Number(row.total_tokens) })) });
  return;

}

export async function creditsTransactionsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const type = url.searchParams.get("type");
  if (type !== "consume" && type !== "topup" && type !== "grant") { errorResponse(res, 400, "INVALID_TRANSACTION_TYPE", "Invalid transaction type"); return; }
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 50);
  let before: { createdAt?: string; id?: string } = {};
  const cursor = url.searchParams.get("cursor");
  try { if (cursor) before = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch {
    errorResponse(res, 400, "INVALID_CURSOR", "Invalid cursor"); return;
  }
  const rows = await DbClient.forUser(token).listCreditTransactionsCursor({
    userId, type, beforeCreatedAt: before.createdAt, beforeId: before.id, limit: limit + 1,
  });
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  jsonResponse(res, {
    items: visible.map((row) => ({
      id: row.id, type: row.type, amount: Number(row.amount), balanceAfter: Number(row.balance_after),
      description: row.description, createdAt: row.created_at,
      ...(row.type === "topup" ? { orderNo: row.reference_id } : {}),
    })),
    nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString("base64url") : null,
  });
  return;

}

export async function creditsPackagesGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  jsonResponse(res, { packages: await paymentService().listPackages() });
  return;

}

export async function creditsPurchasesPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  jsonResponse(res, await paymentService().createPurchase(userId, String(body.packageId ?? "")), 201);
  return;

}

export async function purchaseGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  jsonResponse(res, await paymentService().getPurchase(userId, decodeURIComponent(params[1])));
  return;

}

export async function creditsBalanceGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const db = DbClient.forUser(token);
  const billing = new CreditBillingClient(db);
  const balance = await billing.getBalance(userId);
  if (!balance) {
    jsonResponse(res, { balance: 0, total_granted: 0, total_consumed: 0 });
    return;
  }
  jsonResponse(res, balance);
  return;

}

export async function creditsTopupPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  if (!body.user_id || !body.amount) {
    errorResponse(res, 400, "INVALID_CREDIT_GRANT_INPUT", "Missing user_id or amount");
    return;
  }
  const db = DbClient.forUser(token);
  const billing = new CreditBillingClient(db);
  await billing.ensureBalance(body.user_id, 0);
  const result = await billing.topUp(body.user_id, body.amount, body.description, body.metadata);
  jsonResponse(res, { ok: true, balance: result.balance });
  return;

}

export async function creditsTransactionsGET2({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const db = DbClient.forUser(token);
  const billing = new CreditBillingClient(db);
  const transactions = await billing.listTransactions(userId, limit, offset);
  jsonResponse(res, { transactions });
  return;

}

export async function creditsUsageGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const projectId = url.searchParams.get("project_id") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const db = DbClient.forUser(token);
  const billing = new CreditBillingClient(db);
  const usage = await billing.listUsageRecords(userId, projectId, limit);
  jsonResponse(res, { usage });
  return;

}

export async function creditsLevelsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const db = DbClient.forUser(token);
  const levels = await db.listLevelConfigs();
  jsonResponse(res, { levels });
  return;

}

export async function grantPost({ req, res, url, path, token, identity, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const userId = params[1];
  const body = JSON.parse(await parseBody(req));
  const amount = Number(body.amount ?? 100);
  const description = body.description ? String(body.description) : "系统赠送";
  const db = DbClient.forUser(token);
  const billing = new CreditBillingClient(db);
  await billing.ensureBalance(userId, 0);
  const balance = await billing.topUp(userId, amount, description, undefined, "grant");
  jsonResponse(res, { ok: true, balance });
  return;

}
