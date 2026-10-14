import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Transporter } from "nodemailer";
import { createLogger } from "../lib/logger.js";
import { dispatchEmailOutbox } from "./email-outbox.js";
import { reconcileRegistrationReservations } from "../registration/reconcile.js";
import { expireReferralBindings } from "../referral/expiry.js";
import {
  DAILY_USAGE_REPORT_JOB,
  dailyUsageReportDate,
  determineDailyUsageReportAction,
  determineSchedulerAction,
  executeDailyUsageReport,
  executeOpenCodeSync,
  OPENCODE_SYNC_JOB,
  shanghaiScheduleDate,
  type SchedulerRunState,
} from "./scheduler-service.js";

const log = createLogger("scheduler");

async function dispatchPendingEmail(
  pool: Pool,
  mail: { transporter: Transporter; sender: string },
): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await dispatchEmailOutbox({
      client,
      transporter: mail.transporter,
      sender: mail.sender,
      leaseId: randomUUID(),
    });
    if (result.failed > 0) log.error({ event: "scheduler_email_exhausted", ...result });
    else if (result.claimed > 0) log.info({ event: "scheduler_email_dispatch", ...result });
  } finally {
    client.release();
  }
}

async function loadLatestRun(
  pool: Pool,
  jobName: string,
  scheduleDate: string,
): Promise<SchedulerRunState | null> {
  await pool.query(`
    UPDATE novel.scheduler_runs
    SET status = 'failed', finished_at = now(), error_code = 'stale_run',
        error_message = 'Worker stopped before the run completed',
        next_retry_at = now(), updated_at = now()
    WHERE job_name = $1 AND schedule_date = $2 AND status = 'running'
      AND started_at < now() - interval '15 minutes'
  `, [jobName, scheduleDate]);
  const result = await pool.query(`
    SELECT status, attempt, next_retry_at
    FROM novel.scheduler_runs
    WHERE job_name = $1 AND schedule_date = $2 AND status <> 'dry_run'
    ORDER BY started_at DESC, created_at DESC
    LIMIT 1
  `, [jobName, scheduleDate]);
  const row = result.rows[0];
  return row ? {
    status: row.status,
    attempt: row.attempt,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : null,
  } : null;
}

export async function runSchedulerTick(options: {
  pool: Pool;
  transporter: Transporter;
  sender: string;
  recipient: string;
  now?: Date;
  reconcileRegistrations?: typeof reconcileRegistrationReservations;
  expireReferrals?: typeof expireReferralBindings;
}): Promise<void> {
  const now = options.now ?? new Date();
  const reconciliation = await (options.reconcileRegistrations ?? reconcileRegistrationReservations)(options.pool, now, 100);
  if (reconciliation.finalized > 0 || reconciliation.expired > 0) {
    log.info({ event: "registration_reconciliation", ...reconciliation });
  }
  const expiredReferrals = await (options.expireReferrals ?? expireReferralBindings)(options.pool, now, 500);
  if (expiredReferrals > 0) log.info({ event: "referral_expiry", expired: expiredReferrals });
  await dispatchPendingEmail(options.pool, options);

  const scheduleDate = shanghaiScheduleDate(now);
  const reportDate = dailyUsageReportDate(now);
  const latestReportRun = await loadLatestRun(options.pool, DAILY_USAGE_REPORT_JOB, reportDate);
  const reportAction = determineDailyUsageReportAction(now, latestReportRun);
  if (reportAction) {
    log.info({ event: "scheduler_job_start", job: DAILY_USAGE_REPORT_JOB, reportDate, ...reportAction });
    try {
      const result = await executeDailyUsageReport({
        pool: options.pool,
        reportDate,
        triggerType: reportAction.triggerType,
        attempt: reportAction.attempt,
        recipient: options.recipient,
      });
      log.info({ event: "scheduler_job_complete", job: DAILY_USAGE_REPORT_JOB, status: result.status });
    } catch (error) {
      log.error({
        event: "scheduler_job_failed",
        job: DAILY_USAGE_REPORT_JOB,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const latestRun = await loadLatestRun(options.pool, OPENCODE_SYNC_JOB, scheduleDate);
  const action = determineSchedulerAction(now, latestRun);
  if (action) {
    log.info({ event: "scheduler_job_start", job: OPENCODE_SYNC_JOB, scheduleDate, ...action });
    try {
      const result = await executeOpenCodeSync({
        pool: options.pool,
        scheduleDate,
        triggerType: action.triggerType,
        attempt: action.attempt,
        apply: true,
        recipient: options.recipient,
      });
      log.info({
        event: "scheduler_job_complete",
        job: OPENCODE_SYNC_JOB,
        status: result.status,
        changeCount: result.changeSet?.changes.length ?? 0,
      });
    } catch (error) {
      log.error({
        event: "scheduler_job_failed",
        job: OPENCODE_SYNC_JOB,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await dispatchPendingEmail(options.pool, options);
}
