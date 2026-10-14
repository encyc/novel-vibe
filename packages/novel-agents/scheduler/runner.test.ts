import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchEmailOutbox: vi.fn().mockResolvedValue({ claimed: 0, sent: 0, retried: 0, failed: 0 }),
  executeOpenCodeSync: vi.fn().mockResolvedValue({ status: "succeeded", changeSet: { changes: [] } }),
  executeDailyUsageReport: vi.fn().mockResolvedValue({ status: "succeeded" }),
}));

vi.mock("./email-outbox.js", () => ({ dispatchEmailOutbox: mocks.dispatchEmailOutbox }));
vi.mock("./scheduler-service.js", () => ({
  OPENCODE_SYNC_JOB: "opencode_catalog_sync",
  DAILY_USAGE_REPORT_JOB: "daily_usage_report",
  shanghaiScheduleDate: () => "2026-08-18",
  dailyUsageReportDate: () => "2026-08-17",
  determineSchedulerAction: () => ({ triggerType: "scheduled", attempt: 1 }),
  determineDailyUsageReportAction: () => ({ triggerType: "scheduled", attempt: 1 }),
  executeOpenCodeSync: mocks.executeOpenCodeSync,
  executeDailyUsageReport: mocks.executeDailyUsageReport,
}));

import { runSchedulerTick } from "./runner.js";

describe("scheduler runner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs the daily usage report independently from catalog synchronization", async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await runSchedulerTick({
      pool: pool as never,
      transporter: {} as never,
      sender: "sender@example.com",
      recipient: "owner@example.com",
      now: new Date("2026-08-17T19:10:00Z"),
    });

    expect(mocks.executeDailyUsageReport).toHaveBeenCalledWith(expect.objectContaining({
      reportDate: "2026-08-17",
      recipient: "owner@example.com",
      triggerType: "scheduled",
    }));
    expect(mocks.executeOpenCodeSync).toHaveBeenCalledWith(expect.objectContaining({
      scheduleDate: "2026-08-18",
    }));
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("job_name = $1"), [
      "daily_usage_report",
      "2026-08-17",
    ]);
  });

  it("reconciles interrupted registrations and expires referrals before scheduled work", async () => {
    const reconcileRegistrations = vi.fn().mockResolvedValue({ finalized: 0, expired: 0 });
    const expireReferrals = vi.fn().mockResolvedValue(0);
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const now = new Date("2026-08-18T00:00:00Z");

    await runSchedulerTick({
      pool: pool as never,
      transporter: { sendMail: vi.fn() } as never,
      sender: "sender@example.com",
      recipient: "admin@example.com",
      now,
      reconcileRegistrations,
      expireReferrals,
    });

    expect(reconcileRegistrations).toHaveBeenCalledWith(pool, now, 100);
    expect(expireReferrals).toHaveBeenCalledWith(pool, now, 500);
  });
});
