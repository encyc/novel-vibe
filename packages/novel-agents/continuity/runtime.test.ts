import { describe, expect, it, vi } from "vitest";
import { createContinuityExecutor } from "./runtime.js";
import { sha256Content } from "../lib/storage.js";

const confirmed = "---\ntype: chapter-text\nstatus: confirmed\n---\n正文";

describe("createContinuityExecutor", () => {
  it("runs the Script Supervisor for the exact confirmed revision", async () => {
    const orchestrator = { init: vi.fn(), runContinuityCheckpoint: vi.fn() };
    const execute = createContinuityExecutor({
      getProject: vi.fn().mockResolvedValue({ owner_id: "u1", lifecycle_status: "active", creative_language: "zh-CN" }),
      readChapter: vi.fn().mockResolvedValue(confirmed),
      createOrchestrator: vi.fn().mockReturnValue(orchestrator),
    });

    await execute({
      id: "job-1", project_id: "p1", chapter_number: 3, chapter_path: "text/ch-003.md",
      confirmed_hash: sha256Content(confirmed), attempts: 1,
    });

    expect(orchestrator.init).toHaveBeenCalledOnce();
    expect(orchestrator.runContinuityCheckpoint).toHaveBeenCalledWith(3, "text/ch-003.md", "job-1", sha256Content(confirmed));
  });

  it("completes stale revisions without invoking an Agent", async () => {
    const createOrchestrator = vi.fn();
    const execute = createContinuityExecutor({
      getProject: vi.fn().mockResolvedValue({ owner_id: "u1", lifecycle_status: "active", creative_language: "zh-CN" }),
      readChapter: vi.fn().mockResolvedValue(confirmed),
      createOrchestrator,
    });

    await execute({
      id: "job-1", project_id: "p1", chapter_number: 3, chapter_path: "text/ch-003.md",
      confirmed_hash: "stale-hash", attempts: 1,
    });

    expect(createOrchestrator).not.toHaveBeenCalled();
  });
});
