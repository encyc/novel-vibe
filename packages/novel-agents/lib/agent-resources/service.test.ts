import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentResourceService } from "./service.js";

const remote = "REMOTE";
const hash = createHash("sha256").update(remote).digest("hex");
const active = {
  resourceId: "r1", type: "prompt" as const, key: "writer",
  version: { id: "v1", resourceId: "r1", versionNumber: 1, storagePath: "p/v1.md", contentHash: hash, changeNote: null, createdAt: "now" },
};

function setup(fallbackEnabled = false) {
  const repository = {
    resolveActive: vi.fn().mockResolvedValue(active), nextVersionNumber: vi.fn().mockResolvedValue(2),
    publishVersion: vi.fn().mockResolvedValue(active.version), activateVersion: vi.fn().mockResolvedValue(active.version),
  };
  const storage = { read: vi.fn().mockResolvedValue(remote), writeImmutable: vi.fn(), delete: vi.fn() };
  let now = 0;
  const service = new AgentResourceService({ repository, storage, fallbackEnabled, metadataTtlMs: 30_000, now: () => now });
  return { service, repository, storage, advance: (ms: number) => { now += ms; } };
}

describe("AgentResourceService", () => {
  it("loads verified remote content and caches its metadata", async () => {
    const { service, repository, storage } = setup();
    await expect(service.load({ type: "prompt", key: "writer", fallback: () => "LOCAL" }))
      .resolves.toMatchObject({ content: remote, source: "remote", versionNumber: 1 });
    await service.load({ type: "prompt", key: "writer" });
    expect(repository.resolveActive).toHaveBeenCalledTimes(1);
    expect(storage.read).toHaveBeenCalledTimes(1);
  });

  it("rejects a hash mismatch unless explicit fallback is enabled", async () => {
    const first = setup(); first.storage.read.mockResolvedValue("tampered");
    await expect(first.service.load({ type: "prompt", key: "writer", fallback: () => "LOCAL" }))
      .rejects.toThrow("content hash mismatch");
    const second = setup(true); second.storage.read.mockResolvedValue("tampered");
    await expect(second.service.load({ type: "prompt", key: "writer", fallback: () => "LOCAL" }))
      .resolves.toMatchObject({ content: "LOCAL", source: "fallback" });
    expect(second.service.health().status).toBe("degraded");
  });

  it("uses the last verified version during a later infrastructure failure", async () => {
    const { service, repository, advance } = setup();
    await service.load({ type: "prompt", key: "writer" });
    advance(30_001); repository.resolveActive.mockRejectedValue(new Error("db offline"));
    await expect(service.load({ type: "prompt", key: "writer" }))
      .resolves.toMatchObject({ content: remote, source: "stale_cache" });
  });

  it("publishes hash-addressed content and rolls back by pointer", async () => {
    const { service, repository, storage } = setup();
    const content = "NEW";
    const contentHash = createHash("sha256").update(content).digest("hex");
    await service.publish({ type: "prompt", key: "writer", content });
    expect(storage.writeImmutable).toHaveBeenCalledWith(`prompts/writer/v2-${contentHash}.md`, content);
    expect(repository.publishVersion).toHaveBeenCalledWith(expect.objectContaining({ contentHash, versionNumber: 2 }));
    await service.rollback("prompt", "writer", 1);
    expect(repository.activateVersion).toHaveBeenCalledWith("prompt", "writer", 1);
  });

  it("rejects built-in keys outside the code allowlist", async () => {
    const { service } = setup();
    await expect(service.publish({
      type: "builtin_skill", key: "remote-surprise",
      content: "---\nname: X\ndescription: X\n---\nbody",
    })).rejects.toThrow("not allowlisted");
  });

  it("accepts allowlisted built-ins that describe forbidden capabilities negatively", async () => {
    const { service, repository } = setup();
    await service.publish({
      type: "builtin_skill", key: "skill-creator",
      content: "---\nname: skill-creator\ndescription: Safe creator\n---\nNever create scripts/ or execute shell commands.",
    });
    expect(repository.publishVersion).toHaveBeenCalled();
  });
});
