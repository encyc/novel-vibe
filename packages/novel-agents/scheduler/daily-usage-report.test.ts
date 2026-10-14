import { describe, expect, it, vi } from "vitest";
import {
  dailyUsageReportDate,
  determineDailyUsageReportAction,
  executeDailyUsageReport,
  loadDailyUsageReport,
} from "./scheduler-service.js";

describe("daily usage report scheduling", () => {
  it("reports the previous Shanghai calendar day once 00:10 has passed", () => {
    expect(dailyUsageReportDate(new Date("2026-08-17T16:10:00Z"))).toBe("2026-08-17");
    expect(determineDailyUsageReportAction(new Date("2026-08-17T16:09:00Z"), null)).toBeNull();
    expect(determineDailyUsageReportAction(new Date("2026-08-17T16:10:00Z"), null)).toEqual({
      triggerType: "scheduled",
      attempt: 1,
    });
  });
});

describe("daily usage report aggregation", () => {
  it("uses Shanghai day bounds and actual consume ledger entries", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      new_users: "12",
      total_tokens: "1234567",
      credits_deducted: "345.67",
    }] });
    await expect(loadDailyUsageReport({ query } as never, "2026-08-17")).resolves.toEqual({
      reportDate: "2026-08-17",
      newUsers: 12,
      totalTokens: 1_234_567,
      creditsDeducted: 345.67,
    });

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("Asia/Shanghai");
    expect(sql).toContain("FROM auth.users");
    expect(sql).toContain("SUM(record.total_tokens)");
    expect(sql).toContain("record.user_id IS NOT NULL");
    expect(sql).toContain("FROM novel.credit_transactions");
    expect(sql).toContain("transaction.type = 'consume'");
    expect(sql).toContain("-transaction.amount");
  });

  it("persists a successful run and enqueues its email atomically", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("INSERT INTO novel.scheduler_runs")) return { rows: [{ id: "run-1" }] };
      return { rows: [] };
    });
    const enqueueEmail = vi.fn().mockResolvedValue("mail-1");
    const report = { reportDate: "2026-08-17", newUsers: 12, totalTokens: 1_234_567, creditsDeducted: 345.67 };

    await expect(executeDailyUsageReport({
      pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
      reportDate: "2026-08-17",
      triggerType: "scheduled",
      attempt: 1,
      recipient: "owner@example.com",
      dependencies: {
        loadReport: vi.fn().mockResolvedValue(report),
        enqueueEmail,
      },
    })).resolves.toMatchObject({ status: "succeeded", report });

    expect(enqueueEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      schedulerRunId: "run-1",
      recipient: "owner@example.com",
      message: expect.objectContaining({ subject: expect.stringContaining("2026-08-17") }),
    }));
    expect(query.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    expect(query.mock.calls.some((call) => call[0].includes("status = 'succeeded'"))).toBe(true);
  });

  it("records a failed run, schedules retry, and enqueues a failure alert", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("INSERT INTO novel.scheduler_runs")) return { rows: [{ id: "run-1" }] };
      return { rows: [] };
    });
    const enqueueEmail = vi.fn().mockResolvedValue("mail-1");
    const now = new Date("2026-08-17T16:10:00Z");

    await expect(executeDailyUsageReport({
      pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
      reportDate: "2026-08-17",
      triggerType: "scheduled",
      attempt: 1,
      recipient: "owner@example.com",
      now: () => now,
      dependencies: {
        loadReport: vi.fn().mockRejectedValue(new Error("query failed")),
        enqueueEmail,
      },
    })).rejects.toThrow("query failed");

    expect(query.mock.calls.some((call) => call[0] === "ROLLBACK")).toBe(true);
    const failureUpdate = query.mock.calls.find((call) =>
      call[0].includes("UPDATE novel.scheduler_runs") && call[0].includes("status = 'failed'"));
    expect(failureUpdate?.[1]?.[2]).toEqual(new Date("2026-08-17T16:25:00Z"));
    expect(enqueueEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      message: expect.objectContaining({ subject: expect.stringContaining("生产日报生成失败") }),
    }));
  });
});
