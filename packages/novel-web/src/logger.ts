/**
 * Lightweight scoped logger for the Web BFF — zero dependencies, mirrors the
 * novel-agents logger format so `make logs` shows a consistent layout.
 *
 * Format:  YYYY-MM-DD HH:MM:SS.mmm  LEVEL  [scope] message
 * warn/error → stderr; info/debug → stdout. Plain text (no ANSI) so the
 * launchd log file stays greppable.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function parseLevel(value: string | undefined): LogLevel {
  const v = (value ?? "").toLowerCase();
  return v in LEVEL_VALUE ? (v as LogLevel) : "info";
}

let currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function timestamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

function serialize(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === "string") return arg;
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  function emit(level: LogLevel, args: unknown[]): void {
    if (LEVEL_VALUE[level] < LEVEL_VALUE[currentLevel]) return;
    const levelTag = level.toUpperCase().padEnd(5);
    const msg = args.map(serialize).join(" ");
    const line = `${timestamp()}  ${levelTag} [${scope}] ${msg}`;
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  }
  return {
    debug: (...a: unknown[]) => emit("debug", a),
    info: (...a: unknown[]) => emit("info", a),
    warn: (...a: unknown[]) => emit("warn", a),
    error: (...a: unknown[]) => emit("error", a),
  };
}

