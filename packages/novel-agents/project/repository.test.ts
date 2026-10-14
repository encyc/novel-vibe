import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRepository, type ProjectDataSource } from "./repository.js";

describe("ProjectRepository", () => {
  let dataSource: ProjectDataSource;
  let repository: ProjectRepository;

  beforeEach(() => {
    dataSource = {
      getProject: vi.fn(),
      listProjects: vi.fn(),
      updateProject: vi.fn(),
      transitionProjectLifecycle: vi.fn(),
      enqueueProjectDeletion: vi.fn(),
    };
    repository = new ProjectRepository(dataSource);
  });

  it("lists and updates projects through the scoped data source", async () => {
    vi.mocked(dataSource.listProjects).mockResolvedValue([{ id: "p1", lifecycle_status: "active" }]);
    vi.mocked(dataSource.updateProject).mockResolvedValue({ id: "p1", lifecycle_status: "active", title: "Renamed" });

    await expect(repository.list("active")).resolves.toHaveLength(1);
    await expect(repository.update("p1", { title: "Renamed" })).resolves.toMatchObject({ title: "Renamed" });
  });

  it("delegates permanent deletion enqueue to the system data source", async () => {
    vi.mocked(dataSource.enqueueProjectDeletion).mockResolvedValue({ outcome: "ok", jobId: "j1" });
    await expect(repository.enqueueDeletion("p1", "u1", "j1")).resolves.toEqual({ outcome: "ok", jobId: "j1" });
  });

  it("reads the RLS-visible project", async () => {
    vi.mocked(dataSource.getProject).mockResolvedValue({ id: "p1", lifecycle_status: "active" });
    await expect(repository.getProject("p1")).resolves.toMatchObject({ id: "p1" });
    expect(dataSource.getProject).toHaveBeenCalledWith("p1");
  });

  it("delegates lifecycle transitions to the atomic data-source operation", async () => {
    vi.mocked(dataSource.transitionProjectLifecycle).mockResolvedValue({
      outcome: "ok",
      project: { id: "p1", lifecycle_status: "archived" },
    });

    await expect(repository.transition("p1", "archive")).resolves.toMatchObject({ outcome: "ok" });
    expect(dataSource.transitionProjectLifecycle).toHaveBeenCalledWith("p1", "archive");
  });
});
