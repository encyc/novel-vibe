import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createSchedulerPool } from "./database.js";
import { createSmtpTransportFromEnv, dispatchEmailOutbox } from "./email-outbox.js";
import { reenableOpenCodeModel } from "./catalog-reconcile.js";
import { executeOpenCodeSync, shanghaiScheduleDate } from "./scheduler-service.js";
import { fetchOpenCodeSources, parseOpenCodeCandidate } from "./opencode-source.js";

const USAGE = "Usage: npm --workspace @novel-vibe/agents run scheduler -- "
  + "sync-opencode (--dry-run|--apply) | reenable-opencode <model-id>";

export type SchedulerCliCommand =
  | { command: "sync"; apply: boolean }
  | { command: "reenable"; modelId: string };

export function parseSchedulerCliArgs(args: readonly string[]): SchedulerCliCommand {
  if (args[0] === "sync-opencode"
    && args.length === 2
    && (args[1] === "--dry-run" || args[1] === "--apply")) {
    return { command: "sync", apply: args[1] === "--apply" };
  }
  if (args[0] === "reenable-opencode"
    && args.length === 2
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args[1] ?? "")) {
    return { command: "reenable", modelId: args[1]! };
  }
  throw new Error(USAGE);
}

type SchedulerPool = ReturnType<typeof createSchedulerPool>;

interface SchedulerCliDependencies {
  createPool: () => SchedulerPool;
  now: () => Date;
  fetchSources: typeof fetchOpenCodeSources;
  runtimeModelIds: () => ReadonlySet<string>;
}

const defaultDependencies: SchedulerCliDependencies = {
  createPool: createSchedulerPool,
  now: () => new Date(),
  fetchSources: fetchOpenCodeSources,
  runtimeModelIds: () => new Set(getBuiltinModels("opencode").map((model) => model.id)),
};

async function dispatchPendingMail(pool: SchedulerPool): Promise<void> {
  const mail = createSmtpTransportFromEnv();
  const client = await pool.connect();
  try {
    await dispatchEmailOutbox({
      client,
      transporter: mail.transporter,
      sender: mail.sender,
      leaseId: randomUUID(),
    });
  } finally {
    client.release();
  }
}

export async function runSchedulerCli(
  args: readonly string[],
  overrides: Partial<SchedulerCliDependencies> = {},
): Promise<void> {
  const command = parseSchedulerCliArgs(args);
  const dependencies = { ...defaultDependencies, ...overrides };
  const requiresEmail = command.command === "reenable" || command.apply;
  if (requiresEmail && !process.env.SMTP_EMAIL?.trim()) {
    throw new Error("SMTP_EMAIL is required when applying scheduler changes");
  }

  const pool = dependencies.createPool();
  let shouldDispatchMail = false;
  try {
    if (command.command === "sync") {
      const result = await executeOpenCodeSync({
        pool,
        scheduleDate: shanghaiScheduleDate(dependencies.now()),
        triggerType: "manual",
        attempt: 1,
        apply: command.apply,
        recipient: process.env.SMTP_EMAIL?.trim() || "dry-run@localhost.invalid",
      });
      process.stdout.write(`${JSON.stringify({
        status: result.status,
        runId: result.runId,
        changes: result.changeSet?.changes ?? [],
        report: result.changeSet?.report,
      }, null, 2)}\n`);
      shouldDispatchMail = command.apply;
    } else {
      const sources = await dependencies.fetchSources();
      const candidate = parseOpenCodeCandidate({
        ...sources,
        runtimeModelIds: dependencies.runtimeModelIds(),
      });
      const client = await pool.connect();
      let reenabled = false;
      try {
        await client.query("BEGIN");
        reenabled = await reenableOpenCodeModel(
          client,
          candidate,
          command.modelId,
          process.env.SMTP_EMAIL!.trim(),
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      process.stdout.write(`${JSON.stringify({
        status: reenabled ? "reenabled" : "not_disabled_or_fingerprint_changed",
        modelId: command.modelId,
      }, null, 2)}\n`);
      shouldDispatchMail = reenabled;
    }

    if (shouldDispatchMail) await dispatchPendingMail(pool);
  } finally {
    await pool.end();
  }
}

const isDirectExecution = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href;
if (isDirectExecution) {
  runSchedulerCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Error && error.message.startsWith("Usage:") ? 2 : 1;
  });
}
