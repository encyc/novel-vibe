import type { PoolClient } from "pg";
import nodemailer, { type Transporter } from "nodemailer";
import type { CatalogChange, CatalogChangeSet } from "./catalog-reconcile.js";

export interface SystemEmailMessage {
  subject: string;
  text: string;
  html?: string;
}

export interface DailyUsageReport {
  reportDate: string;
  newUsers: number;
  totalTokens: number;
  creditsDeducted: number;
}

interface OutboxRow {
  id: string;
  recipient: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  attempt_count: number;
}

const CHANGE_LABELS: Record<CatalogChange["kind"], string> = {
  added: "已新增并自动上架",
  activated: "已恢复上架",
  deactivated: "已自动下架",
  price_updated: "价格已更新",
  peak_updated: "Peak 时段价格已更新",
  context_tiers_updated: "长上下文分档价格已更新",
  unsupported_observed: "上游已新增，但当前运行时暂不支持（未上架）",
  dynamic_discovered: "已发现可动态适配的新模型",
  dynamic_activated: "动态运行时已自动上架",
  dynamic_reenabled: "运行时已更新并恢复上架",
  dynamic_retired: "动态运行时已下架",
  unsupported_endpoint: "端点协议不受支持（未上架）",
};

function rateDetails(change: CatalogChange): string {
  if (change.kind !== "price_updated" || !change.before || !change.after
    || typeof change.before !== "object" || typeof change.after !== "object") return "";
  const before = change.before as Record<string, unknown>;
  const after = change.after as Record<string, unknown>;
  const details: string[] = [];
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const oldValue = before[key];
    const newValue = after[key];
    if (typeof oldValue !== "number" || typeof newValue !== "number" || oldValue === newValue) continue;
    const delta = oldValue === 0
      ? "从 0 启用"
      : `${newValue >= oldValue ? "+" : ""}${(((newValue - oldValue) / oldValue) * 100).toFixed(2)}%`;
    details.push(`${key} ${oldValue} → ${newValue} (${delta})`);
  }
  return details.length > 0 ? `；${details.join("，")}` : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlFromLines(lines: string[]): string {
  return lines.map((line) => line
    ? `<p>${escapeHtml(line)}</p>`
    : "<br>").join("\n");
}

export function renderDailyUsageReportEmail(report: DailyUsageReport): SystemEmailMessage {
  const lines = [
    `Novel Vibe 生产日报（${report.reportDate}，Asia/Shanghai）`,
    "",
    `新增用户：${report.newUsers.toLocaleString("en-US")}`,
    `Token 用量：${report.totalTokens.toLocaleString("en-US")}`,
    `扣减 Credit：${report.creditsDeducted.toFixed(2)}`,
  ];
  return {
    subject: `[Novel Vibe] 生产日报（${report.reportDate}）`,
    text: lines.join("\n"),
    html: htmlFromLines(lines),
  };
}

export function renderDailyUsageReportFailureEmail(
  reportDate: string,
  error: unknown,
  willRetry: boolean,
): SystemEmailMessage {
  const safeMessage = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ").trim().slice(0, 1_000);
  const lines = [
    `Novel Vibe 生产日报生成失败（${reportDate}，Asia/Shanghai）。`,
    `错误：${safeMessage || "未知错误"}`,
    willRetry
      ? "系统会按 15 分钟、1 小时、3 小时的策略自动重试。"
      : "今日自动重试次数已用完，请检查 scheduler-worker 日志。",
  ];
  return {
    subject: `[Novel Vibe] 生产日报生成失败（${reportDate}）`,
    text: lines.join("\n"),
    html: htmlFromLines(lines),
  };
}

export function renderCatalogChangeEmail(
  changeSet: CatalogChangeSet,
  scheduleDate: string,
): SystemEmailMessage {
  const lines = [
    `OpenCode Zen 模型目录同步已完成（${scheduleDate}）。`,
    "",
    "已自动生效的变更：",
    ...changeSet.changes.map((change) =>
      `- ${change.modelId}：${CHANGE_LABELS[change.kind]}${rateDetails(change)}`),
  ];
  if (changeSet.report.unsupportedEndpointModelIds.length > 0) {
    lines.push("", "上游端点协议当前不受支持（未上架）：", ...changeSet.report.unsupportedEndpointModelIds.map((id) => `- ${id}`));
  }
  if (changeSet.report.unpricedRuntimeModelIds.length > 0) {
    lines.push("", "上游未提供完整价格（未上架或已下架）：", ...changeSet.report.unpricedRuntimeModelIds.map((id) => `- ${id}`));
  }
  if (changeSet.report.disabledRuntimeModelIds.length > 0) {
    lines.push("", "因确定性兼容错误保持下架：", ...changeSet.report.disabledRuntimeModelIds.map((id) => `- ${id}`));
  }
  lines.push("", "价格换算仍使用：官方 USD / 1M tokens × 0.07 Credits / 1K tokens；用户等级系数另行计算。");
  return {
    subject: `[Novel Vibe] OpenCode 模型目录已更新（${scheduleDate}）`,
    text: lines.join("\n"),
    html: htmlFromLines(lines),
  };
}

export function renderSchedulerFailureEmail(
  scheduleDate: string,
  error: unknown,
  willRetry = true,
): SystemEmailMessage {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage = rawMessage.replace(/\s+/g, " ").trim().slice(0, 1_000);
  const lines = [
    `OpenCode Zen 模型目录同步执行失败（${scheduleDate}）。`,
    "本次没有应用任何模型或价格变更。",
    `错误：${safeMessage || "未知错误"}`,
    willRetry
      ? "系统会按 15 分钟、1 小时、3 小时的策略自动重试。"
      : "今日自动重试次数已用完，请检查服务日志。",
  ];
  return {
    subject: `[Novel Vibe] OpenCode 模型目录同步执行失败（${scheduleDate}）`,
    text: lines.join("\n"),
    html: htmlFromLines(lines),
  };
}

export async function enqueueSystemEmail(
  client: PoolClient,
  input: { schedulerRunId: string | null; recipient: string; message: SystemEmailMessage },
): Promise<string> {
  const result = await client.query(`
    INSERT INTO novel.system_email_outbox (
      scheduler_run_id, recipient, subject, text_body, html_body
    ) VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [
    input.schedulerRunId,
    input.recipient,
    input.message.subject,
    input.message.text,
    input.message.html ?? null,
  ]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Failed to enqueue scheduler email");
  return id;
}

export function createSmtpTransportFromEnv(env: NodeJS.ProcessEnv = process.env): {
  transporter: Transporter;
  sender: string;
  recipient: string;
} {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_EMAIL", "SMTP_PASSWORD"] as const;
  for (const name of required) {
    if (!env[name]?.trim()) throw new Error(`Missing required scheduler environment variable: ${name}`);
  }
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("SMTP_PORT must be a valid TCP port");
  }
  const sender = env.SMTP_EMAIL!.trim();
  return {
    transporter: nodemailer.createTransport({
      host: env.SMTP_HOST!.trim(),
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      tls: { rejectUnauthorized: true },
      auth: { user: sender, pass: env.SMTP_PASSWORD! },
    }),
    sender,
    recipient: sender,
  };
}

export async function dispatchEmailOutbox(options: {
  client: PoolClient;
  transporter: Transporter;
  sender: string;
  leaseId: string;
  limit?: number;
  leaseSeconds?: number;
  now?: () => Date;
}): Promise<{ claimed: number; sent: number; retried: number; failed: number }> {
  const claimed = await options.client.query<OutboxRow>(
    "SELECT * FROM novel.claim_system_email_outbox($1, $2, $3)",
    [options.limit ?? 20, options.leaseId, options.leaseSeconds ?? 300],
  );
  const result = { claimed: claimed.rows.length, sent: 0, retried: 0, failed: 0 };
  const retryMinutes = [5, 30, 120];
  for (const row of claimed.rows) {
    try {
      await options.transporter.sendMail({
        from: options.sender,
        to: row.recipient,
        subject: row.subject,
        text: row.text_body,
        html: row.html_body ?? undefined,
      });
      await options.client.query(`
        UPDATE novel.system_email_outbox
        SET status = 'sent', sent_at = now(), lease_id = NULL,
            lease_expires_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND lease_id = $2
      `, [row.id, options.leaseId]);
      result.sent += 1;
    } catch (error) {
      const retryDelay = retryMinutes[row.attempt_count - 1];
      const willRetry = retryDelay !== undefined;
      const nextAttemptAt = willRetry
        ? new Date((options.now?.() ?? new Date()).getTime() + retryDelay * 60_000)
        : null;
      const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      await options.client.query(`
        UPDATE novel.system_email_outbox
        SET status = $1, next_attempt_at = COALESCE($2, next_attempt_at),
            last_error = $3, lease_id = NULL, lease_expires_at = NULL,
            updated_at = now()
        WHERE id = $4 AND lease_id = $5
      `, [willRetry ? "pending" : "failed", nextAttemptAt, errorMessage, row.id, options.leaseId]);
      if (willRetry) result.retried += 1;
      else result.failed += 1;
    }
  }
  return result;
}
