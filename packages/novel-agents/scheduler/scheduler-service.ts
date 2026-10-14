import type { Pool, PoolClient } from "pg";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  applyCatalogChangeSet,
  buildCatalogChangeSet,
  loadOpenCodeCatalogState,
  type CatalogChangeSet,
  type CurrentCatalogState,
} from "./catalog-reconcile.js";
import {
  enqueueSystemEmail,
  renderCatalogChangeEmail,
  renderDailyUsageReportEmail,
  renderDailyUsageReportFailureEmail,
  renderSchedulerFailureEmail,
  type DailyUsageReport,
  type SystemEmailMessage,
} from "./email-outbox.js";
import {
  fetchOpenCodeSources,
  parseOpenCodeCandidate,
  type OpenCodeCandidate,
  type OpenCodeSources,
} from "./opencode-source.js";

export const OPENCODE_SYNC_JOB = "opencode_catalog_sync";
export const DAILY_USAGE_REPORT_JOB = "daily_usage_report";

export interface SchedulerRunState {
  status: "running" | "succeeded" | "failed" | "dry_run";
  attempt: number;
  nextRetryAt: Date | null;
}

export interface SchedulerAction {
  triggerType: "scheduled" | "catchup" | "retry";
  attempt: number;
}

interface SyncDependencies {
  fetchSources: () => Promise<OpenCodeSources>;
  runtimeModelIds: () => ReadonlySet<string>;
  parseCandidate: (input: {
    modelsJson: unknown;
    pricingMarkdown: string;
    runtimeModelIds: ReadonlySet<string>;
  }) => OpenCodeCandidate;
  loadState: (client: PoolClient) => Promise<CurrentCatalogState>;
  buildChangeSet: (candidate: OpenCodeCandidate, state: CurrentCatalogState) => CatalogChangeSet;
  applyChangeSet: (client: PoolClient, changeSet: CatalogChangeSet) => Promise<void>;
  enqueueEmail: (
    client: PoolClient,
    input: { schedulerRunId: string | null; recipient: string; message: SystemEmailMessage },
  ) => Promise<string>;
}

const defaultDependencies: SyncDependencies = {
  fetchSources: fetchOpenCodeSources,
  runtimeModelIds: () => new Set(getBuiltinModels("opencode").map((model) => model.id)),
  parseCandidate: parseOpenCodeCandidate,
  loadState: loadOpenCodeCatalogState,
  buildChangeSet: buildCatalogChangeSet,
  applyChangeSet: applyCatalogChangeSet,
  enqueueEmail: enqueueSystemEmail,
};

function shanghaiParts(now: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export function shanghaiScheduleDate(now: Date): string {
  return shanghaiParts(now).date;
}

export function dailyUsageReportDate(now: Date): string {
  const localDate = shanghaiScheduleDate(now);
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

function determineActionAtMinute(
  now: Date,
  latestRun: SchedulerRunState | null,
  scheduledMinute: number,
): SchedulerAction | null {
  const local = shanghaiParts(now);
  if (latestRun) {
    if (latestRun.status !== "failed") return null;
    if (latestRun.attempt >= 4 || !latestRun.nextRetryAt || latestRun.nextRetryAt > now) return null;
    return { triggerType: "retry", attempt: latestRun.attempt + 1 };
  }
  const minuteOfDay = local.hour * 60 + local.minute;
  if (minuteOfDay < scheduledMinute) return null;
  return {
    triggerType: minuteOfDay === scheduledMinute ? "scheduled" : "catchup",
    attempt: 1,
  };
}

export function determineDailyUsageReportAction(
  now: Date,
  latestRun: SchedulerRunState | null,
): SchedulerAction | null {
  return determineActionAtMinute(now, latestRun, 10);
}

export async function loadDailyUsageReport(
  client: Pick<PoolClient, "query">,
  reportDate: string,
): Promise<DailyUsageReport> {
  const result = await client.query<{
    new_users: string;
    total_tokens: string;
    credits_deducted: string;
  }>(`
    WITH bounds AS (
      SELECT
        $1::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS starts_at,
        ($1::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS ends_at
    )
    SELECT
      (SELECT COUNT(*)
       FROM auth.users AS app_user, bounds
       WHERE app_user.created_at >= bounds.starts_at
         AND app_user.created_at < bounds.ends_at
         AND COALESCE(app_user.is_anonymous, false) = false) AS new_users,
      (SELECT COALESCE(SUM(record.total_tokens), 0)
       FROM novel.usage_records AS record, bounds
       WHERE record.created_at >= bounds.starts_at
         AND record.created_at < bounds.ends_at
         AND record.user_id IS NOT NULL) AS total_tokens,
      (SELECT COALESCE(SUM(-transaction.amount), 0)
       FROM novel.credit_transactions AS transaction, bounds
       WHERE transaction.type = 'consume'
         AND transaction.created_at >= bounds.starts_at
         AND transaction.created_at < bounds.ends_at) AS credits_deducted
  `, [reportDate]);
  const row = result.rows[0];
  return {
    reportDate,
    newUsers: Number(row?.new_users ?? 0),
    totalTokens: Number(row?.total_tokens ?? 0),
    creditsDeducted: Number(row?.credits_deducted ?? 0),
  };
}

interface DailyUsageReportDependencies {
  loadReport: typeof loadDailyUsageReport;
  enqueueEmail: typeof enqueueSystemEmail;
}

export async function executeDailyUsageReport(options: {
  pool: Pool;
  reportDate: string;
  triggerType: "scheduled" | "catchup" | "retry" | "manual";
  attempt: number;
  recipient: string;
  now?: () => Date;
  dependencies?: Partial<DailyUsageReportDependencies>;
}): Promise<{ status: "succeeded" | "skipped_locked"; runId?: string; report?: DailyUsageReport }> {
  const dependencies = {
    loadReport: loadDailyUsageReport,
    enqueueEmail: enqueueSystemEmail,
    ...options.dependencies,
  };
  const client = await options.pool.connect();
  let locked = false;
  let inTransaction = false;
  let runId: string | null = null;
  try {
    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [DAILY_USAGE_REPORT_JOB],
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) return { status: "skipped_locked" };

    const inserted = await client.query<{ id: string }>(`
      INSERT INTO novel.scheduler_runs (
        job_name, schedule_date, trigger_type, attempt, status
      ) VALUES ($1, $2, $3, $4, 'running')
      RETURNING id
    `, [DAILY_USAGE_REPORT_JOB, options.reportDate, options.triggerType, options.attempt]);
    runId = inserted.rows[0]?.id ?? null;
    if (!runId) throw new Error("Failed to create daily usage report run");

    await client.query("BEGIN");
    inTransaction = true;
    const report = await dependencies.loadReport(client, options.reportDate);
    await dependencies.enqueueEmail(client, {
      schedulerRunId: runId,
      recipient: options.recipient,
      message: renderDailyUsageReportEmail(report),
    });
    await client.query(`
      UPDATE novel.scheduler_runs
      SET status = 'succeeded', finished_at = now(), summary = $1::jsonb,
          error_code = NULL, error_message = NULL, next_retry_at = NULL, updated_at = now()
      WHERE id = $2
    `, [JSON.stringify(report), runId]);
    await client.query("COMMIT");
    inTransaction = false;
    return { status: "succeeded", runId, report };
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK");
      inTransaction = false;
    }
    if (runId) {
      const failureNow = options.now?.() ?? new Date();
      const nextRetryAt = options.triggerType === "manual"
        ? null
        : retryAtForFailedAttempt(options.attempt, failureNow);
      const errorCode = errorCodeFor(error);
      const previousFailure = await client.query<{ error_code: string | null }>(`
        SELECT error_code
        FROM novel.scheduler_runs
        WHERE job_name = $1 AND schedule_date = $2 AND status = 'failed' AND id <> $3
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1
      `, [DAILY_USAGE_REPORT_JOB, options.reportDate, runId]);
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(`
        UPDATE novel.scheduler_runs
        SET status = 'failed', finished_at = now(), error_code = $1,
            error_message = $2, next_retry_at = $3, updated_at = now()
        WHERE id = $4
      `, [errorCode, safeErrorMessage(error), nextRetryAt, runId]);
      if (shouldEnqueueFailureAlert(
        previousFailure.rows[0]?.error_code ?? null,
        errorCode,
        options.attempt,
      )) {
        await dependencies.enqueueEmail(client, {
          schedulerRunId: runId,
          recipient: options.recipient,
          message: renderDailyUsageReportFailureEmail(options.reportDate, error, nextRetryAt !== null),
        });
      }
      await client.query("COMMIT");
      inTransaction = false;
    }
    throw error;
  } finally {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [DAILY_USAGE_REPORT_JOB]).catch(() => undefined);
    }
    client.release();
  }
}

export function determineSchedulerAction(
  now: Date,
  latestRun: SchedulerRunState | null,
): SchedulerAction | null {
  return determineActionAtMinute(now, latestRun, 3 * 60 + 10);
}

function retryAtForFailedAttempt(attempt: number, now: Date): Date | null {
  const delayMinutes = [15, 60, 180][attempt - 1];
  return delayMinutes === undefined ? null : new Date(now.getTime() + delayMinutes * 60_000);
}

function errorCodeFor(error: unknown): string {
  const raw = error instanceof Error ? error.name : "sync_failed";
  return raw.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9_]+/g, "_").toLowerCase().slice(0, 80)
    || "sync_failed";
}

export function shouldEnqueueFailureAlert(
  previousErrorCode: string | null,
  currentErrorCode: string,
  attempt: number,
): boolean {
  return attempt >= 4 || previousErrorCode !== currentErrorCode;
}

export function addUnsupportedDiscoveryChanges(
  changeSet: CatalogChangeSet,
  previousUnsupportedModelIds: ReadonlySet<string>,
): CatalogChangeSet {
  const discoveries = changeSet.report.unsupportedEndpointModelIds
    .filter((modelId) => !previousUnsupportedModelIds.has(modelId))
    .map((modelId) => ({ kind: "unsupported_endpoint" as const, modelId }));
  return discoveries.length === 0
    ? changeSet
    : { ...changeSet, changes: [...changeSet.changes, ...discoveries] };
}

async function loadPreviousUnsupportedModelIds(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ unsupported_model_ids: unknown }>(`
    SELECT COALESCE(
      summary #> '{report,unsupportedEndpointModelIds}',
      summary #> '{report,unsupportedModelIds}'
    ) AS unsupported_model_ids
    FROM novel.scheduler_runs
    WHERE job_name = $1 AND status = 'succeeded'
    ORDER BY finished_at DESC NULLS LAST
    LIMIT 1
  `, [OPENCODE_SYNC_JOB]);
  const value = result.rows[0]?.unsupported_model_ids;
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function summaryFor(changeSet: CatalogChangeSet): object {
  return {
    change_count: changeSet.changes.length,
    changes: changeSet.changes,
    report: changeSet.report,
  };
}

export async function executeOpenCodeSync(options: {
  pool: Pool;
  scheduleDate: string;
  triggerType: "scheduled" | "catchup" | "retry" | "manual";
  attempt: number;
  apply: boolean;
  recipient: string;
  now?: () => Date;
  dependencies?: Partial<SyncDependencies>;
}): Promise<{ status: "succeeded" | "dry_run" | "skipped_locked"; runId?: string; changeSet?: CatalogChangeSet }> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const client = await options.pool.connect();
  let locked = false;
  let inTransaction = false;
  let runId: string | null = null;
  let candidate: OpenCodeCandidate | null = null;
  let databaseScheduleDate: string | null = null;
  try {
    const lockResult = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [OPENCODE_SYNC_JOB],
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) return { status: "skipped_locked" };

    databaseScheduleDate = options.triggerType === "manual" ? null : options.scheduleDate;
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO novel.scheduler_runs (
        job_name, schedule_date, trigger_type, attempt, status
      ) VALUES ($1, $2, $3, $4, 'running')
      RETURNING id
    `, [OPENCODE_SYNC_JOB, databaseScheduleDate, options.triggerType, options.attempt]);
    runId = inserted.rows[0]?.id ?? null;
    if (!runId) throw new Error("Failed to create scheduler run");

    const sources = await dependencies.fetchSources();
    candidate = dependencies.parseCandidate({
      ...sources,
      runtimeModelIds: dependencies.runtimeModelIds(),
    });
    const state = await dependencies.loadState(client);
    const previousUnsupported = await loadPreviousUnsupportedModelIds(client);
    const changeSet = addUnsupportedDiscoveryChanges(
      dependencies.buildChangeSet(candidate, state),
      previousUnsupported,
    );

    if (!options.apply) {
      await client.query(`
        UPDATE novel.scheduler_runs
        SET status = 'dry_run', finished_at = now(),
            models_source_hash = $1, pricing_source_hash = $2, parser_version = $3,
            summary = $4::jsonb, updated_at = now()
        WHERE id = $5
      `, [
        candidate.sourceHashes.models,
        candidate.sourceHashes.pricing,
        candidate.parserVersion,
        JSON.stringify(summaryFor(changeSet)),
        runId,
      ]);
      return { status: "dry_run", runId, changeSet };
    }

    await client.query("BEGIN");
    inTransaction = true;
    await dependencies.applyChangeSet(client, changeSet);
    await client.query(`
      UPDATE novel.scheduler_runs
      SET status = 'succeeded', finished_at = now(),
          models_source_hash = $1, pricing_source_hash = $2, parser_version = $3,
          summary = $4::jsonb, error_code = NULL, error_message = NULL,
          next_retry_at = NULL, updated_at = now()
      WHERE id = $5
    `, [
      candidate.sourceHashes.models,
      candidate.sourceHashes.pricing,
      candidate.parserVersion,
      JSON.stringify(summaryFor(changeSet)),
      runId,
    ]);
    if (changeSet.changes.length > 0) {
      await dependencies.enqueueEmail(client, {
        schedulerRunId: runId,
        recipient: options.recipient,
        message: renderCatalogChangeEmail(changeSet, options.scheduleDate),
      });
    }
    await client.query("COMMIT");
    inTransaction = false;
    return { status: "succeeded", runId, changeSet };
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK");
      inTransaction = false;
    }
    if (runId) {
      const failureNow = options.now?.() ?? new Date();
      const nextRetryAt = options.triggerType === "manual"
        ? null
        : retryAtForFailedAttempt(options.attempt, failureNow);
      const errorCode = errorCodeFor(error);
      try {
        await client.query("BEGIN");
        inTransaction = true;
        const previousFailure = await client.query<{ error_code: string | null }>(`
          SELECT error_code
          FROM novel.scheduler_runs
          WHERE job_name = $1 AND schedule_date IS NOT DISTINCT FROM $2
            AND status = 'failed' AND id <> $3
          ORDER BY finished_at DESC NULLS LAST
          LIMIT 1
        `, [OPENCODE_SYNC_JOB, databaseScheduleDate, runId]);
        await client.query(`
          UPDATE novel.scheduler_runs
          SET status = 'failed', finished_at = now(), error_code = $1,
              error_message = $2, next_retry_at = $3,
              models_source_hash = $4, pricing_source_hash = $5,
              parser_version = $6, updated_at = now()
          WHERE id = $7
        `, [
          errorCode,
          safeErrorMessage(error),
          nextRetryAt,
          candidate?.sourceHashes.models ?? null,
          candidate?.sourceHashes.pricing ?? null,
          candidate?.parserVersion ?? null,
          runId,
        ]);
        if (options.apply && shouldEnqueueFailureAlert(
          previousFailure.rows[0]?.error_code ?? null,
          errorCode,
          options.attempt,
        )) {
          await dependencies.enqueueEmail(client, {
            schedulerRunId: runId,
            recipient: options.recipient,
            message: renderSchedulerFailureEmail(options.scheduleDate, error, nextRetryAt !== null),
          });
        }
        await client.query("COMMIT");
        inTransaction = false;
      } catch (auditError) {
        if (inTransaction) await client.query("ROLLBACK");
        throw new AggregateError([error, auditError], "OpenCode sync failed and its failure audit could not be persisted");
      }
    }
    throw error;
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [OPENCODE_SYNC_JOB]).catch(() => undefined);
    }
    client.release();
  }
}
