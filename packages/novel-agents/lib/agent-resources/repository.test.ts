import { describe, expect, it, vi } from "vitest";
import { PostgrestAgentResourceRepository } from "./repository.js";

function db() {
  return {
    getActiveAgentResource: vi.fn(),
    getNextAgentResourceVersion: vi.fn(),
    publishAgentResourceVersion: vi.fn(),
    activateAgentResourceVersion: vi.fn(),
  };
}

const versionRow = {
  id: "v1", resource_id: "r1", version_number: 2,
  storage_path: "prompts/writer/v2-h.md", content_hash: "a".repeat(64),
  change_note: null, created_at: "2026-07-13T00:00:00Z",
};

describe("PostgrestAgentResourceRepository", () => {
  it("maps an active resource row", async () => {
    const client = db();
    client.getActiveAgentResource.mockResolvedValue({
      id: "r1", resource_type: "prompt", resource_key: "writer",
      active_version: versionRow,
    });
    const repository = new PostgrestAgentResourceRepository(client as never);

    await expect(repository.resolveActive("prompt", "writer")).resolves.toEqual({
      resourceId: "r1", type: "prompt", key: "writer",
      version: {
        id: "v1", resourceId: "r1", versionNumber: 2,
        storagePath: "prompts/writer/v2-h.md", contentHash: "a".repeat(64),
        changeNote: null, createdAt: "2026-07-13T00:00:00Z",
      },
    });
  });

  it("returns null for a missing active resource", async () => {
    const client = db();
    client.getActiveAgentResource.mockResolvedValue(null);
    await expect(new PostgrestAgentResourceRepository(client as never)
      .resolveActive("prompt", "writer")).resolves.toBeNull();
  });

  it("rejects malformed rows", async () => {
    const client = db();
    client.getActiveAgentResource.mockResolvedValue({ id: "r1", active_version: {} });
    await expect(new PostgrestAgentResourceRepository(client as never)
      .resolveActive("prompt", "writer")).rejects.toThrow("Malformed agent resource row");
  });

  it("maps publish and activate RPC results", async () => {
    const client = db();
    client.publishAgentResourceVersion.mockResolvedValue(versionRow);
    client.activateAgentResourceVersion.mockResolvedValue(versionRow);
    const repository = new PostgrestAgentResourceRepository(client as never);
    const input = {
      resourceType: "prompt" as const, resourceKey: "writer", versionNumber: 2,
      storagePath: versionRow.storage_path, contentHash: versionRow.content_hash,
    };
    await expect(repository.publishVersion(input)).resolves.toMatchObject({ versionNumber: 2 });
    await expect(repository.activateVersion("prompt", "writer", 2))
      .resolves.toMatchObject({ versionNumber: 2 });
  });
});
