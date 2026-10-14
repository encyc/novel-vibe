import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("createProject", () => {
    it("sends POST with project fields and return=representation", async () => {
      ctx.mockOk([{ id: "abc-123", title: "test" }]);
      await ctx.db.createProject({ title: "测试", genre: "玄幻", synopsis: "简介" });

      const [url, opts] = ctx.fetchMock.mock.calls[0];
      expect(opts.method).toBe("POST");
      expect(url).toContain("/projects");
      const headers = opts.headers as Record<string, string>;
      expect(headers?.Prefer).toBe("return=representation");

      const body = JSON.parse(opts.body as string);
      expect(body.title).toBe("测试");
      expect(body.genre).toBe("玄幻");
      expect(body.storage_path).toMatch(/^novels\//);
    });

    it("returns the created project row", async () => {
      ctx.mockOk([{ id: "abc-123", title: "测试", storage_path: "novels/abc" }]);
      const result = await ctx.db.createProject({ title: "测试" });
      expect(result.id).toBe("abc-123");
    });

    it("includes owner_id when provided", async () => {
      ctx.mockOk([{ id: "x" }]);
      await ctx.db.createProject({ ownerId: "user-1", title: "test" });
      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.owner_id).toBe("user-1");
    });

    it("serializes the requested creative language", async () => {
      ctx.mockOk([{ id: "x" }]);
      await ctx.db.createProject({ title: "English novel", creativeLanguage: "en" });
      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.creative_language).toBe("en");
    });

    it("defaults creative language to Chinese for existing callers", async () => {
      ctx.mockOk([{ id: "x" }]);
      await ctx.db.createProject({ title: "测试" });
      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.creative_language).toBe("zh-CN");
    });
  });

describe("transitionProjectLifecycle", () => {
    it("calls the atomic lifecycle RPC and returns its result", async () => {
      ctx.mockOkRaw({ outcome: "ok", project: { id: "p1", lifecycle_status: "archived" } });

      const result = await ctx.db.transitionProjectLifecycle("p1", "archive");

      const [url, init] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("/rpc/transition_project_lifecycle");
      expect(JSON.parse(init.body)).toEqual({ p_project_id: "p1", p_command: "archive" });
      expect(result).toMatchObject({ outcome: "ok" });
    });

    it("throws when the lifecycle RPC fails", async () => {
      ctx.mockError(409, "transition failed");
      await expect(ctx.db.transitionProjectLifecycle("p1", "trash"))
        .rejects.toThrow("Project lifecycle transition failed [409]");
    });
  });

describe("getProject", () => {
    it("returns project when found", async () => {
      ctx.mockOk([{ id: "abc", title: "test" }]);
      const result = await ctx.db.getProject("abc");
      expect(result).toEqual({ id: "abc", title: "test" });
    });

    it("returns null when not found", async () => {
      ctx.mockOk([]);
      const result = await ctx.db.getProject("nonexistent");
      expect(result).toBeNull();
    });
  });

describe("listProjects", () => {
    it("lists all projects ordered by recent activity", async () => {
      ctx.mockOk([{ id: "a" }, { id: "b" }]);
      const result = await ctx.db.listProjects();
      expect(result).toHaveLength(2);
      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("order=last_activity_at.desc,id.desc");
    });

    it("filters by owner_id when provided", async () => {
      ctx.mockOk([{ id: "a" }]);
      await ctx.db.listProjects("user-1");
      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("owner_id=eq.user-1");
    });

    it("filters by lifecycle status when provided", async () => {
      ctx.mockOk([]);
      await ctx.db.listProjects(undefined, "archived");
      expect(ctx.fetchMock.mock.calls[0][0]).toContain("lifecycle_status=eq.archived");
    });
  });

describe("project management writes", () => {
    it("updates only the supplied project metadata", async () => {
      ctx.mockOk([{ id: "p1", lifecycle_status: "active", title: "Renamed" }]);
      await expect(ctx.db.updateProject("p1", { title: "Renamed" })).resolves.toMatchObject({ title: "Renamed" });
      const [url, init] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("/projects?id=eq.p1");
      expect(init.method).toBe("PATCH");
      expect(init.headers.Prefer).toBe("return=representation");
    });

    it("enqueues deletion through the system RPC", async () => {
      ctx.mockOkRaw({ outcome: "ok", jobId: "j1" });
      await expect(ctx.db.enqueueProjectDeletion("p1", "u1", "j1")).resolves.toEqual({ outcome: "ok", jobId: "j1" });
      const [url, init] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("/rpc/enqueue_project_deletion");
      expect(JSON.parse(init.body)).toEqual({ p_project_id: "p1", p_requested_by: "u1", p_job_id: "j1" });
    });
  });

describe("createTask", () => {
    it("creates task with all fields", async () => {
      ctx.mockOk([{ id: "task-1", status: "pending" }]);
      await ctx.db.createTask({
        projectId: "proj-1",
        agent: "writer",
        taskType: "create",
        description: "写章节",
        outputPath: "text/chapter-001.md",
      });

      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.project_id).toBe("proj-1");
      expect(body.agent).toBe("writer");
      expect(body.task_type).toBe("create");
      expect(body.output_path).toBe("text/chapter-001.md");
    });

    it("uses return=representation preference", async () => {
      ctx.mockOk([{ id: "task-1" }]);
      await ctx.db.createTask({ projectId: "p", agent: "writer", taskType: "create" });
      const headers = ctx.fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers?.Prefer).toBe("return=representation");
    });
  });

describe("continuity jobs", () => {
    it("enqueues a confirmed chapter revision idempotently", async () => {
      ctx.mockOk([]);

      await ctx.db.enqueueContinuityJob({
        projectId: "p1", chapterNumber: 3, chapterPath: "text/ch-003.md", confirmedHash: "hash-3",
      });

      const [url, init] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("/continuity_jobs?on_conflict=project_id%2Cchapter_path%2Cconfirmed_hash");
      expect(init.headers.Prefer).toContain("resolution=ignore-duplicates");
      expect(JSON.parse(init.body)).toEqual({
        project_id: "p1", chapter_number: 3, chapter_path: "text/ch-003.md", confirmed_hash: "hash-3",
      });
    });

    it("claims due continuity work through the system RPC", async () => {
      ctx.mockOkRaw([{ id: "job-1" }]);

      await expect(ctx.db.claimContinuityJobs("2026-08-19T00:00:00.000Z", 5)).resolves.toEqual([{ id: "job-1" }]);

      const [url, init] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("/rpc/claim_continuity_jobs");
      expect(JSON.parse(init.body)).toEqual({
        p_now: "2026-08-19T00:00:00.000Z", p_limit: 5, p_lease_seconds: 300,
      });
    });

    it("records retry state without exposing the lease", async () => {
      ctx.mockOk([]);

      await ctx.db.retryContinuityJob("job-1", 2, "2026-08-19T00:01:00.000Z", "model unavailable");

      const [, init] = ctx.fetchMock.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual(expect.objectContaining({
        status: "pending", attempts: 2, next_attempt_at: "2026-08-19T00:01:00.000Z",
        last_error: "model unavailable", lease_id: null, lease_expires_at: null,
        updated_at: expect.any(String),
      }));
    });
  });

describe("updateTaskStatus", () => {
    it("updates status via PATCH", async () => {
      ctx.mockOk();
      await ctx.db.updateTaskStatus("task-1", "approved");
      const [url, opts] = ctx.fetchMock.mock.calls[0];
      expect(opts.method).toBe("PATCH");
      expect(JSON.parse(opts.body as string)).toMatchObject({ status: "approved" });
    });

    it("sets completed_at for approved/rejected", async () => {
      ctx.mockOk();
      await ctx.db.updateTaskStatus("task-1", "rejected", "needs fix");
      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.status).toBe("rejected");
      expect(body.review_note).toBe("needs fix");
      expect(body.completed_at).toBeDefined();
    });
  });

describe("listTasks", () => {
    it("builds URL with project_id, order, and limit", async () => {
      ctx.mockOk([]);
      await ctx.db.listTasks("proj-1", 10);
      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("project_id=eq.proj-1");
      expect(url).toContain("order=created_at.desc");
      expect(url).toContain("limit=10");
    });

    it("defaults limit to 50", async () => {
      ctx.mockOk([]);
      await ctx.db.listTasks("proj-1");
      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("limit=50");
    });
  });
