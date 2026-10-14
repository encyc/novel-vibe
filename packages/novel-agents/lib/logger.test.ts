import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWriters,
  __setWriters,
  createLogger,
  getLogLevel,
  setLogLevel,
} from "./logger.js";

describe("logger", () => {
  const origLevel = getLogLevel();
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    __setWriters(
      (s) => void out.push(s),
      (s) => void err.push(s),
    );
  });

  afterEach(() => {
    __resetWriters();
    setLogLevel(origLevel);
  });

  it("formats with timestamp, padded level, and scope", () => {
    createLogger("server").info("hello");
    expect(out[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}  INFO  \[server\] hello\n$/,
    );
  });

  it("left-pads the level tag to a fixed width", () => {
    createLogger("db").warn("careful");
    expect(err[0]).toContain(" WARN  [db] careful");
  });

  it("routes warn/error to stderr and info/debug to stdout", () => {
    const log = createLogger("x");
    log.info("i");
    log.debug("d"); // filtered at default (info) level
    log.warn("w");
    log.error("e");
    expect(out).toHaveLength(1); // info only
    expect(err).toHaveLength(2); // warn + error
  });

  it("respects LOG_LEVEL filtering", () => {
    setLogLevel("warn");
    const log = createLogger("x");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(out).toHaveLength(0); // info/debug filtered out
    expect(err).toHaveLength(2); // warn + error pass
  });

  it("shows debug when level is debug", () => {
    setLogLevel("debug");
    createLogger("x").debug("trace");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("DEBUG [x] trace");
  });

  it("serializes Error args with message + stack on stderr", () => {
    createLogger("db").error("query failed", new Error("boom"));
    const written = err.join("");
    expect(written).toContain("[db] query failed");
    expect(written).toContain("Error: boom");
    expect(written).toContain("\n    at ");
  });

  it("serializes a bare Error on stderr", () => {
    createLogger("db").error(new Error("boom"));
    const written = err.join("");
    expect(written).toContain("Error: boom");
    expect(written).toContain(" at ");
  });

  it("serializes objects as JSON", () => {
    createLogger("api").info("payload", { ok: true, n: 3 });
    expect(out[0]).toContain('{"ok":true,"n":3}');
  });

  it("joins multiple args with spaces", () => {
    createLogger("api").info("user", 42, "done");
    expect(out[0]).toContain("[api] user 42 done");
  });

  it("creates nested scopes via child()", () => {
    createLogger("agents").child("credits").info("tick");
    expect(out[0]).toContain("[agents.credits] tick");
  });
});
