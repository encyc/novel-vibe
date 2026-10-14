/**
 * Lightweight scoped logger — zero dependencies.
 *
 * Format:  YYYY-MM-DD HH:MM:SS.mmm  LEVEL  [scope] message
 *
 * - Levels (debug/info/warn/error) gated by `LOG_LEVEL` (default "info").
 * - warn/error → stderr; info/debug → stdout. launchd merges both into the
 *   same file, so the on-disk log captures everything.
 * - Plain text only (no ANSI). Files stay greppable; the `make logs` viewer
 *   adds color on the terminal side.
 * - `Error` args expand to `message + "\n" + stack`; objects JSON-stringify.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(value: string | undefined): LogLevel {
  const v = (value ?? "").toLowerCase();
  return v in LEVEL_VALUE ? (v as LogLevel) : "info";
}

let currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

/** Override the active level at runtime (used by tests). */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Current active level. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** ISO-ish timestamp: 2026-07-06 14:23:01.482 */
function timestamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

function serialize(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }
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

function format(scope: string, level: LogLevel, args: unknown[]): string {
  const msg = args.map(serialize).join(" ");
  const levelTag = level.toUpperCase().padEnd(5);
  return `${timestamp()}  ${levelTag} [${scope}] ${msg}`;
}

// Injectable sinks so tests can capture output without spying on Node streams
// (process.stdout/stderr spy interception is unreliable across vitest/Node).
let writeOut: (s: string) => void = (s) => process.stdout.write(s);
let writeErr: (s: string) => void = (s) => process.stderr.write(s);

/** @internal Reset sinks to the real process streams. */
export function __resetWriters(): void {
  writeOut = (s) => process.stdout.write(s);
  writeErr = (s) => process.stderr.write(s);
}

/** @internal Inject capture sinks for tests. */
export function __setWriters(out: (s: string) => void, err: (s: string) => void): () => void {
  writeOut = out;
  writeErr = err;
  return __resetWriters;
}

export interface Logger {
  scope: string;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Create a nested logger with a `parent.child` scope. */
  child(childScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  function emit(level: LogLevel, args: unknown[]): void {
    if (LEVEL_VALUE[level] < LEVEL_VALUE[currentLevel]) return;
    const line = format(scope, level, args);
    (level === "error" || level === "warn" ? writeErr : writeOut)(line + "\n");
  }

  return {
    scope,
    debug: (...args: unknown[]) => emit("debug", args),
    info: (...args: unknown[]) => emit("info", args),
    warn: (...args: unknown[]) => emit("warn", args),
    error: (...args: unknown[]) => emit("error", args),
    child(childScope: string): Logger {
      return createLogger(`${scope}.${childScope}`);
    },
  };
}

/** Module-level convenience logger (scope "app"). Prefer `createLogger`. */
export const logger = createLogger("app");
