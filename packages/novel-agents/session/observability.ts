import { createLogger } from "../lib/logger.js";

type TelemetryFields = Record<string, unknown>;
type LogWriter = (line: string) => void;

const telemetryLog = createLogger("telemetry");

const ALLOWED_KEYS = new Set([
  "sessionId",
  "projectId",
  "userId",
  "leaseId",
  "turnId",
  "agentId",
  "durationMs",
  "queueDepth",
  "stage",
  "errorCode",
  "status",
]);

function sanitize(fields: TelemetryFields): TelemetryFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => ALLOWED_KEYS.has(key)
      && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")),
  );
}

export class SessionTelemetry {
  constructor(private readonly write: LogWriter = (line) => telemetryLog.info(line)) {}

  info(event: string, fields: TelemetryFields = {}): void {
    this.emit("info", { event, ...sanitize(fields) });
  }

  error(event: string, fields: TelemetryFields = {}): void {
    this.emit("error", { event, ...sanitize(fields) });
  }

  increment(metric: string): void {
    this.emit("metric", { metric, value: 1 });
  }

  private emit(level: "info" | "error" | "metric", fields: TelemetryFields): void {
    this.write(JSON.stringify({ level, ...fields }));
  }
}
