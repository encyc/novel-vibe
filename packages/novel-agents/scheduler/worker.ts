import "dotenv/config";
import { createLogger } from "../lib/logger.js";
import { createSchedulerPool } from "./database.js";
import { createSmtpTransportFromEnv } from "./email-outbox.js";
import { runSchedulerTick } from "./runner.js";

const log = createLogger("scheduler.worker");
const pool = createSchedulerPool();
const mail = createSmtpTransportFromEnv();
let running = false;
let stopped = false;

async function tick(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    await runSchedulerTick({ pool, ...mail });
  } catch (error) {
    log.error({ event: "scheduler_tick_failed", error: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopped) return;
  stopped = true;
  log.info({ event: "scheduler_shutdown", signal });
  while (running) await new Promise((resolve) => setTimeout(resolve, 100));
  await pool.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

log.info({
  event: "scheduler_started",
  timezone: "Asia/Shanghai",
  schedules: { dailyUsageReport: "00:10", openCodeCatalogSync: "03:10" },
});
await tick();
const interval = setInterval(() => void tick(), 60_000);
await new Promise<void>((resolve) => {
  process.once("SIGTERM", () => resolve());
  process.once("SIGINT", () => resolve());
});
clearInterval(interval);
