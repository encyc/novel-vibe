import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectService, type ProjectRepositoryPort } from "./service.js";

describe("ProjectService", () => {
  let repository: ProjectRepositoryPort;
  let service: ProjectService;

  beforeEach(() => {
    repository = {
      getProject: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      transition: vi.fn(),
      enqueueDeletion: vi.fn(),
    };
    service = new ProjectService(repository);
  });

  it("lists, reads, and updates project metadata", async () => {
    vi.mocked(repository.list).mockResolvedValue([{ id: "p1", lifecycle_status: "active" }]);
    vi.mocked(repository.getProject).mockResolvedValue({ id: "p1", lifecycle_status: "active" });
    vi.mocked(repository.update).mockResolvedValue({ id: "p1", lifecycle_status: "active", title: "Renamed" });

    await expect(service.list({ lifecycleStatus: "active" })).resolves.toHaveLength(1);
    await expect(service.get("p1")).resolves.toMatchObject({ id: "p1" });
    await expect(service.update("p1", { title: " Renamed ", writingStage: "drafting" }))
      .resolves.toMatchObject({ title: "Renamed" });
    expect(repository.update).toHaveBeenCalledWith("p1", { title: "Renamed", writing_stage: "drafting" });
  });

  it("rejects invalid project metadata", async () => {
    await expect(service.update("p1", { title: "   " })).rejects.toMatchObject({ code: "INVALID_PROJECT_INPUT", status: 400 });
    await expect(service.update("p1", { writingStage: "unknown" as never })).rejects.toMatchObject({ code: "INVALID_PROJECT_INPUT" });
  });

  it("maps creativeLanguage to the database patch", async () => {
    vi.mocked(repository.update).mockResolvedValue({
      id: "p1",
      creative_language: "en",
      lifecycle_status: "active",
    });

    await service.update("p1", { creativeLanguage: "en" });

    expect(repository.update).toHaveBeenCalledWith("p1", { creative_language: "en" });
  });

  it("rejects an unsupported creative language", async () => {
    await expect(service.update("p1", { creativeLanguage: "fr" as never }))
      .rejects.toMatchObject({ code: "INVALID_PROJECT_INPUT", status: 400 });
  });

  it("enqueues permanent deletion and maps queue outcomes", async () => {
    vi.mocked(repository.enqueueDeletion)
      .mockResolvedValueOnce({ outcome: "ok", jobId: "job-1" })
      .mockResolvedValueOnce({ outcome: "invalid", from: "active" })
      .mockResolvedValueOnce({ outcome: "busy", sessionId: "s1" });

    await expect(service.permanentlyDelete({ projectId: "p1", userId: "u1" })).resolves.toEqual({ jobId: "job-1" });
    await expect(service.permanentlyDelete({ projectId: "p1", userId: "u1" })).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_TRANSITION" });
    await expect(service.permanentlyDelete({ projectId: "p1", userId: "u1" })).rejects.toMatchObject({ code: "RESOURCE_BUSY" });
  });

  it.each([
    ["archive", "archived"],
    ["trash", "trash"],
    ["restore", "active"],
  ] as const)("runs the %s command and returns its project", async (command, lifecycleStatus) => {
    vi.mocked(repository.transition).mockResolvedValue({
      outcome: "ok",
      project: { id: "p1", lifecycle_status: lifecycleStatus },
    });

    await expect(service[command]({ projectId: "p1" })).resolves.toMatchObject({
      id: "p1",
      lifecycle_status: lifecycleStatus,
    });
  });

  it("maps a processing blocker to RESOURCE_BUSY", async () => {
    vi.mocked(repository.transition).mockResolvedValue({ outcome: "busy", sessionId: "s-running" });
    await expect(service.archive({ projectId: "p1" })).rejects.toMatchObject({
      code: "RESOURCE_BUSY",
      status: 409,
      details: { sessionId: "s-running" },
    });
  });

  it("maps invalid, purge, and invisible outcomes to stable errors", async () => {
    vi.mocked(repository.transition)
      .mockResolvedValueOnce({ outcome: "invalid", from: "trash", command: "archive" })
      .mockResolvedValueOnce({ outcome: "purge_in_progress" })
      .mockResolvedValueOnce({ outcome: "not_found" });

    await expect(service.archive({ projectId: "p1" })).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_TRANSITION" });
    await expect(service.restore({ projectId: "p1" })).rejects.toMatchObject({ code: "PURGE_IN_PROGRESS" });
    await expect(service.trash({ projectId: "p1" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
  });

  it("allows writes only for active projects", async () => {
    vi.mocked(repository.getProject)
      .mockResolvedValueOnce({ id: "p1", lifecycle_status: "active" })
      .mockResolvedValueOnce({ id: "p2", lifecycle_status: "archived" })
      .mockResolvedValueOnce(null);

    await expect(service.assertProjectWritable("p1")).resolves.toBeUndefined();
    await expect(service.assertProjectWritable("p2")).rejects.toMatchObject({ code: "PROJECT_READ_ONLY" });
    await expect(service.assertProjectWritable("missing")).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
  });
});
