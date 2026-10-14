import { describe, expect, it, vi } from "vitest";
import type { CatalogChangeSet, CurrentCatalogState } from "./catalog-reconcile.js";
import type { OpenCodeCandidate } from "./opencode-source.js";
import {
  addUnsupportedDiscoveryChanges,
  determineSchedulerAction,
  executeOpenCodeSync,
  shanghaiScheduleDate,
  shouldEnqueueFailureAlert,
  type SchedulerRunState,
} from "./scheduler-service.js";

describe("scheduler timing", () => {
  it("uses the Asia/Shanghai calendar date", () => {
    expect(shanghaiScheduleDate(new Date("2026-08-16T16:30:00Z"))).toBe("2026-08-17");
  });

  it("runs once after 03:10 and never replays an older date", () => {
    const before = new Date("2026-08-16T19:09:00Z");
    const onTime = new Date("2026-08-16T19:10:00Z");
    const late = new Date("2026-08-16T22:00:00Z");
    expect(determineSchedulerAction(before, null)).toBeNull();
    expect(determineSchedulerAction(onTime, null)).toEqual({ triggerType: "scheduled", attempt: 1 });
    expect(determineSchedulerAction(late, null)).toEqual({ triggerType: "catchup", attempt: 1 });
  });

  it("waits for due retries and stops after the third retry", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const failed: SchedulerRunState = {
      status: "failed", attempt: 2, nextRetryAt: new Date("2026-08-16T23:59:00Z"),
    };
    expect(determineSchedulerAction(now, failed)).toEqual({ triggerType: "retry", attempt: 3 });
    expect(determineSchedulerAction(now, { ...failed, nextRetryAt: new Date("2026-08-17T00:01:00Z") })).toBeNull();
    expect(determineSchedulerAction(now, { ...failed, attempt: 4, nextRetryAt: null })).toBeNull();
    expect(determineSchedulerAction(now, { status: "succeeded", attempt: 1, nextRetryAt: null })).toBeNull();
  });
});

describe("scheduler notifications", () => {
  it("treats only newly unsupported upstream models as a change", () => {
    const enriched = addUnsupportedDiscoveryChanges({
      ...changeSet,
      changes: [],
      report: {
        ...changeSet.report,
        unsupportedEndpointModelIds: ["known", "new-model"],
        unsupportedModelIds: ["known", "new-model"],
      },
    }, new Set(["known"]));
    expect(enriched.changes).toEqual([{ kind: "unsupported_endpoint", modelId: "new-model" }]);
  });

  it("suppresses duplicate failure alerts but always sends the final one", () => {
    expect(shouldEnqueueFailureAlert(null, "type_error", 1)).toBe(true);
    expect(shouldEnqueueFailureAlert("type_error", "type_error", 2)).toBe(false);
    expect(shouldEnqueueFailureAlert("network_error", "type_error", 2)).toBe(true);
    expect(shouldEnqueueFailureAlert("type_error", "type_error", 4)).toBe(true);
  });
});

const candidate: OpenCodeCandidate = {
  parserVersion: "1",
  sourceHashes: { models: "models-hash", pricing: "pricing-hash" },
  observedModelIds: ["model"],
  unsupportedEndpointModelIds: [],
  unsupportedModelIds: [],
  unpricedRuntimeModelIds: [],
  models: [],
};
const state: CurrentCatalogState = { rates: [], timeWindows: [], contextTiers: [], runtimes: [] };
const changeSet: CatalogChangeSet = {
  runtimeUpserts: [], retireRuntimeIds: [],
  upserts: [], deactivateRateIds: [],
  changes: [{ kind: "added", modelId: "model" }],
  report: {
    unsupportedEndpointModelIds: [], unsupportedModelIds: [],
    unpricedRuntimeModelIds: [], disabledRuntimeModelIds: [], preservedWildcardModelIds: [],
  },
};

describe("executeOpenCodeSync", () => {
  it("applies changes and enqueues the change email in the success transaction", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("INSERT INTO novel.scheduler_runs")) return { rows: [{ id: "run-1" }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const apply = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue("mail-1");

    const result = await executeOpenCodeSync({
      pool: { connect: vi.fn().mockResolvedValue({ query, release }) } as never,
      scheduleDate: "2026-08-17",
      triggerType: "scheduled",
      attempt: 1,
      apply: true,
      recipient: "admin@example.com",
      dependencies: {
        fetchSources: vi.fn().mockResolvedValue({ modelsJson: {}, pricingMarkdown: "prices" }),
        runtimeModelIds: () => new Set(["model"]),
        parseCandidate: vi.fn().mockReturnValue(candidate),
        loadState: vi.fn().mockResolvedValue(state),
        buildChangeSet: vi.fn().mockReturnValue(changeSet),
        applyChangeSet: apply,
        enqueueEmail: enqueue,
      },
    });

    expect(result.status).toBe("succeeded");
    expect(apply).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ schedulerRunId: "run-1" }));
    expect(query.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    expect(release).toHaveBeenCalled();
  });

  it("rolls back mutations, records failure, and schedules the first retry", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("INSERT INTO novel.scheduler_runs")) return { rows: [{ id: "run-1" }] };
      return { rows: [] };
    });
    const enqueue = vi.fn().mockResolvedValue("mail-1");
    const now = new Date("2026-08-17T00:00:00Z");

    await expect(executeOpenCodeSync({
      pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
      scheduleDate: "2026-08-17",
      triggerType: "scheduled",
      attempt: 1,
      apply: true,
      recipient: "admin@example.com",
      now: () => now,
      dependencies: {
        fetchSources: vi.fn().mockResolvedValue({ modelsJson: {}, pricingMarkdown: "prices" }),
        runtimeModelIds: () => new Set(["model"]),
        parseCandidate: vi.fn().mockReturnValue(candidate),
        loadState: vi.fn().mockResolvedValue(state),
        buildChangeSet: vi.fn().mockReturnValue(changeSet),
        applyChangeSet: vi.fn().mockRejectedValue(new Error("write failed")),
        enqueueEmail: enqueue,
      },
    })).rejects.toThrow("write failed");

    expect(query.mock.calls.some((call) => call[0] === "ROLLBACK")).toBe(true);
    const failureUpdate = query.mock.calls.find((call) =>
      call[0].includes("UPDATE novel.scheduler_runs") && call[0].includes("status = 'failed'"));
    expect(failureUpdate?.[1]?.[2]).toEqual(new Date("2026-08-17T00:15:00Z"));
    expect(enqueue).toHaveBeenCalled();
  });
});
