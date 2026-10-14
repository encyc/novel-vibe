/**
 * Z-Pay payment integration helpers.
 *
 * Ported from novel-mono/backend/src/api/billing/zpay_router.py.
 * Handles MD5 signature generation/verification and payment URL construction.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const ZPAY_SUBMIT_URL = "https://zpayz.cn/submit.php";
const ZPAY_API_URL = "https://zpayz.cn/api.php";

// Lazy getters — read env at call time, not at import time (dotenv loads after imports in ESM)
export const getZpayPid = () => process.env.ZPAY_PID ?? "";
export const getZpayKey = () => process.env.ZPAY_KEY ?? "";
const getZpayNotifyUrl = () => process.env.ZPAY_NOTIFY_URL ?? "";
const getZpayReturnUrl = () => process.env.ZPAY_RETURN_URL ?? "";

// ─── Config check ────────────────────────────────────────────────────

export function isZPayConfigured(): boolean {
  return Boolean(getZpayPid() && getZpayKey());
}

// ─── Signature ───────────────────────────────────────────────────────

export function generateSign(params: Record<string, string>, key: string): string {
  const filtered = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .filter(([k]) => k !== "sign" && k !== "sign_type")
    .sort(([a], [b]) => a.localeCompare(b));

  const signStr = filtered.map(([k, v]) => `${k}=${v}`).join("&") + key;
  return createHash("md5").update(signStr, "utf8").digest("hex");
}

export function verifySign(params: Record<string, string>, key: string): boolean {
  const sign = params.sign;
  if (!sign) return false;
  const expected = Buffer.from(generateSign(params, key), "utf8");
  const actual = Buffer.from(sign, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface ZPayNotification {
  pid: string;
  out_trade_no: string;
  trade_no: string;
  trade_status: string;
  money: string;
  param: string;
  sign: string;
  sign_type: string;
}

export function parseNotification(params: URLSearchParams): ZPayNotification | null {
  const required = ["pid", "out_trade_no", "trade_no", "trade_status", "money", "param", "sign", "sign_type"] as const;
  const values = Object.fromEntries(required.map((key) => [key, params.get(key) ?? ""])) as unknown as ZPayNotification;
  return required.every((key) => values[key]) ? values : null;
}

// ─── Order ID ────────────────────────────────────────────────────────

export function generateOutTradeNo(kind: "credit" | "membership" = "credit"): string {
  const ts = Date.now();
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  return kind === "membership" ? `MC-${ts}${rand}` : `NOVEL${ts}${rand}`;
}

// ─── Build payment URL ───────────────────────────────────────────────

export function buildPayUrl(params: {
  outTradeNo: string;
  name: string;
  money: string;
  userId: string;
}): string {
  const pid = getZpayPid();
  const key = getZpayKey();
  const zpayParams: Record<string, string> = {
    pid,
    type: "alipay",
    out_trade_no: params.outTradeNo,
    notify_url: getZpayNotifyUrl(),
    return_url: getZpayReturnUrl(),
    name: params.name,
    money: params.money,
    param: params.userId,
  };

  zpayParams.sign = generateSign(zpayParams, key);
  zpayParams.sign_type = "MD5";

  const qs = Object.entries(zpayParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  return `${ZPAY_SUBMIT_URL}?${qs}`;
}

// ─── Query order status from Z-Pay ──────────────────────────────────

export async function queryOrderStatus(outTradeNo: string): Promise<{
  code: number;
  status: number;
  [key: string]: unknown;
} | null> {
  const pid = getZpayPid();
  const key = getZpayKey();
  const url = `${ZPAY_API_URL}?act=order&pid=${pid}&key=${key}&out_trade_no=${outTradeNo}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as any;
  } catch {
    return null;
  }
}
