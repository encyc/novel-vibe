import { describe, expect, it, vi } from "vitest";
import type { CatalogChangeSet } from "./catalog-reconcile.js";
import {
  createSmtpTransportFromEnv,
  dispatchEmailOutbox,
  renderCatalogChangeEmail,
  renderDailyUsageReportEmail,
  renderDailyUsageReportFailureEmail,
  renderSchedulerFailureEmail,
} from "./email-outbox.js";

const changeSet: CatalogChangeSet = {
  runtimeUpserts: [],
  retireRuntimeIds: [],
  upserts: [],
  deactivateRateIds: ["rate-old"],
  changes: [
    { kind: "price_updated", modelId: "deepseek-v4-pro", before: { input: 1 }, after: { input: 2 } },
    { kind: "deactivated", modelId: "old-model" },
    { kind: "dynamic_reenabled", modelId: "gpt-5.6-sol" },
    { kind: "unsupported_endpoint", modelId: "bad-endpoint-model" },
  ],
  report: {
    unsupportedEndpointModelIds: ["future-model"],
    unsupportedModelIds: ["future-model"],
    unpricedRuntimeModelIds: ["legacy-model"],
    disabledRuntimeModelIds: ["disabled-model"],
    preservedWildcardModelIds: ["claude-%"],
  },
};

describe("scheduler email rendering", () => {
  it("renders the daily user, token, and deducted credit totals", () => {
    const message = renderDailyUsageReportEmail({
      reportDate: "2026-08-17",
      newUsers: 12,
      totalTokens: 1_234_567,
      creditsDeducted: 345.67,
    });
    expect(message.subject).toContain("2026-08-17");
    expect(message.text).toContain("新增用户：12");
    expect(message.text).toContain("Token 用量：1,234,567");
    expect(message.text).toContain("扣减 Credit：345.67");
    expect(message.html).toContain("1,234,567");
  });

  it("describes applied price and availability changes", () => {
    const message = renderCatalogChangeEmail(changeSet, "2026-08-17");
    expect(message.subject).toContain("OpenCode 模型目录已更新");
    expect(message.text).toContain("deepseek-v4-pro：价格已更新");
    expect(message.text).toContain("input 1 → 2 (+100.00%)");
    expect(message.text).toContain("old-model：已自动下架");
    expect(message.text).toContain("gpt-5.6-sol：运行时已更新并恢复上架");
    expect(message.text).toContain("bad-endpoint-model：端点协议不受支持（未上架）");
    expect(message.text).toContain("future-model");
    expect(message.text).toContain("legacy-model");
    expect(message.text).toContain("disabled-model");
  });

  it("uses implicit TLS on 465 and requires STARTTLS elsewhere", () => {
    const base = { SMTP_HOST: "smtp.example.com", SMTP_EMAIL: "admin@example.com", SMTP_PASSWORD: "secret" };
    const implicit = createSmtpTransportFromEnv({ ...base, SMTP_PORT: "465" });
    const startTls = createSmtpTransportFromEnv({ ...base, SMTP_PORT: "587" });
    expect((implicit.transporter as unknown as { options: object }).options).toEqual(expect.objectContaining({ secure: true }));
    expect((startTls.transporter as unknown as { options: object }).options).toEqual(expect.objectContaining({
      secure: false, requireTLS: true, tls: { rejectUnauthorized: true },
    }));
  });

  it("sends scheduler notifications to the SMTP administrator email", () => {
    const mail = createSmtpTransportFromEnv({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_EMAIL: "sender@example.com",
      SMTP_PASSWORD: "secret",
    });
    expect(mail.sender).toBe("sender@example.com");
    expect(mail.recipient).toBe("sender@example.com");
  });

  it("renders a failure alert without leaking a stack trace", () => {
    const message = renderSchedulerFailureEmail("2026-08-17", new Error("source failed\nsecret stack"));
    expect(message.subject).toContain("执行失败");
    expect(message.text).toContain("source failed secret stack");
    expect(message.text).not.toContain("Error:");
  });

  it("renders a daily report failure alert with retry status", () => {
    const message = renderDailyUsageReportFailureEmail(
      "2026-08-17",
      new Error("query failed\nsecret stack"),
      true,
    );
    expect(message.subject).toContain("生产日报生成失败");
    expect(message.text).toContain("query failed secret stack");
    expect(message.text).toContain("自动重试");
  });
});

describe("dispatchEmailOutbox", () => {
  it("marks successful sends as sent", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "mail-1", recipient: "admin@example.com", subject: "subject",
        text_body: "body", html_body: null, attempt_count: 1,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const sendMail = vi.fn().mockResolvedValue({ messageId: "sent" });

    const result = await dispatchEmailOutbox({
      client: { query } as never,
      transporter: { sendMail } as never,
      sender: "admin@example.com",
      leaseId: "00000000-0000-4000-8000-000000000001",
    });

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: "admin@example.com", to: "admin@example.com", subject: "subject",
    }));
    expect(query.mock.calls[1]?.[0]).toContain("status = 'sent'");
  });

  it.each([
    [1, "pending", 5],
    [2, "pending", 30],
    [3, "pending", 120],
    [4, "failed", null],
  ])("handles failed attempt %s with status %s", async (attempt, status, minutes) => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "mail-1", recipient: "admin@example.com", subject: "subject",
        text_body: "body", html_body: null, attempt_count: attempt,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const now = new Date("2026-08-17T00:00:00.000Z");

    const result = await dispatchEmailOutbox({
      client: { query } as never,
      transporter: { sendMail: vi.fn().mockRejectedValue(new Error("SMTP unavailable")) } as never,
      sender: "admin@example.com",
      leaseId: "00000000-0000-4000-8000-000000000001",
      now: () => now,
    });

    expect(query.mock.calls[1]?.[1]?.[0]).toBe(status);
    expect(query.mock.calls[1]?.[1]?.[1]).toEqual(
      minutes === null ? null : new Date(now.getTime() + minutes * 60_000),
    );
    expect(result[status === "failed" ? "failed" : "retried"]).toBe(1);
  });
});
