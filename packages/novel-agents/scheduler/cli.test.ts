import { describe, expect, it, vi } from "vitest";
import { parseSchedulerCliArgs, runSchedulerCli } from "./cli.js";

describe("scheduler CLI", () => {
  it.each([
    [["sync-opencode", "--dry-run"], { command: "sync", apply: false }],
    [["sync-opencode", "--apply"], { command: "sync", apply: true }],
    [["reenable-opencode", "gpt-5.6-sol"], { command: "reenable", modelId: "gpt-5.6-sol" }],
  ])("parses %j", (args, expected) => {
    expect(parseSchedulerCliArgs(args)).toEqual(expected);
  });

  it.each([
    [[]],
    [["sync-opencode"]],
    [["sync-opencode", "--apply", "extra"]],
    [["reenable-opencode"]],
    [["reenable-opencode", "bad model"]],
    [["reenable-opencode", "model%"]],
    [["reenable-opencode", "model", "extra"]],
    [["unknown"]],
  ])("rejects invalid arguments before opening a database pool: %j", async (args) => {
    const createPool = vi.fn();
    await expect(runSchedulerCli(args, { createPool } as never)).rejects.toThrow("Usage:");
    expect(createPool).not.toHaveBeenCalled();
  });
});
