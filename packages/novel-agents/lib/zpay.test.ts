import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPayUrl,
  generateOutTradeNo,
  generateSign,
  isZPayConfigured,
  queryOrderStatus,
  verifySign,
} from "./zpay.js";

describe("zpay helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("checks config and signs filtered params deterministically", () => {
    vi.stubEnv("ZPAY_PID", "pid-1");
    vi.stubEnv("ZPAY_KEY", "secret");

    const params = { b: "2", a: "1", sign_type: "MD5", empty: "", sign: "ignored" };
    const sign = generateSign(params, "secret");

    expect(isZPayConfigured()).toBe(true);
    expect(sign).toBe("8d9f51949e440aa629fd1a035708473a");
    expect(verifySign({ ...params, sign }, "secret")).toBe(true);
    expect(verifySign({ ...params, sign, a: "tampered" }, "secret")).toBe(false);
    expect(verifySign(params, "secret")).toBe(false);
  });

  it("builds payment urls with encoded fields", () => {
    vi.stubEnv("ZPAY_PID", "pid-1");
    vi.stubEnv("ZPAY_KEY", "secret");
    vi.stubEnv("ZPAY_NOTIFY_URL", "https://example.test/notify");
    vi.stubEnv("ZPAY_RETURN_URL", "https://example.test/return");

    const url = new URL(buildPayUrl({
      outTradeNo: "ORDER 1",
      name: "积分套餐",
      money: "9.90",
      userId: "user-1",
    }));

    expect(url.origin + url.pathname).toBe("https://zpayz.cn/submit.php");
    expect(url.searchParams.get("pid")).toBe("pid-1");
    expect(url.searchParams.get("name")).toBe("积分套餐");
    expect(url.searchParams.get("out_trade_no")).toBe("ORDER 1");
    expect(url.searchParams.get("sign_type")).toBe("MD5");
    expect(url.searchParams.get("sign")).toHaveLength(32);
  });

  it("generates order ids and returns null when order query fails", async () => {
    vi.stubEnv("ZPAY_PID", "pid-1");
    vi.stubEnv("ZPAY_KEY", "secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    expect(generateOutTradeNo()).toMatch(/^NOVEL\d+[a-f0-9]{8}$/);
    await expect(queryOrderStatus("order-1")).resolves.toBeNull();
  });
});

describe("generateOutTradeNo", () => {
  it("uses NOVEL prefix for credit orders by default", () => {
    const no = generateOutTradeNo();
    expect(no).toMatch(/^NOVEL\d+/);
  });

  it("uses MC- prefix for membership orders", () => {
    const no = generateOutTradeNo("membership");
    expect(no).toMatch(/^MC-\d+/);
  });

  it("accepts explicit credit kind", () => {
    const no = generateOutTradeNo("credit");
    expect(no).toMatch(/^NOVEL\d+/);
  });
});
