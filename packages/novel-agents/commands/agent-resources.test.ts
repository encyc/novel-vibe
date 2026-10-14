import { describe, expect, it, vi } from "vitest";
import { runAgentResourceCommand } from "./agent-resources.js";

function deps() {
  return {
    service: { publish: vi.fn(), rollback: vi.fn(), verifyRequired: vi.fn().mockResolvedValue({ status: "healthy", degraded: [] }) },
    repository: { resolveActive: vi.fn().mockResolvedValue(null) },
    readFile: vi.fn().mockResolvedValue("BODY"),
    writeLine: vi.fn(),
  };
}

describe("agent resource command", () => {
  it("publishes a file with a change note", async () => {
    const d = deps();
    await expect(runAgentResourceCommand(
      ["publish", "prompt", "writer", "/tmp/writer.md", "--note", "tighten voice"], d as never,
    )).resolves.toBe(0);
    expect(d.service.publish).toHaveBeenCalledWith({
      type: "prompt", key: "writer", content: "BODY", changeNote: "tighten voice",
    });
  });

  it("rejects an invalid rollback version", async () => {
    await expect(runAgentResourceCommand(
      ["rollback", "prompt", "writer", "x"], deps() as never,
    )).rejects.toThrow("version must be a positive integer");
  });

  it("seeds missing packaged resources", async () => {
    const d = deps();
    await expect(runAgentResourceCommand(["seed"], d as never)).resolves.toBe(0);
    expect(d.service.publish).toHaveBeenCalledTimes(25);
  });
});
