import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTaskTools, createAssignTaskTool, createApproveTaskTool, createRejectTaskTool } from "./task-tools.js";
import type { ToolContext } from "./file-tools.js";

function mockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    storage: { read: vi.fn(), write: vi.fn(), search: vi.fn(), list: vi.fn(), delete: vi.fn() } as any,
    db: {
      createTask: vi.fn(),
      updateTaskStatus: vi.fn(),
    } as any,
    projectId: "test-project-id",
    ...overrides,
  };
}

describe("task-tools", () => {
  describe("createAssignTaskTool", () => {
    it("has correct metadata", () => {
      const tool = createAssignTaskTool(mockContext());
      expect(tool.name).toBe("assign_task");
      expect(tool.label).toBe("Assign Task to Sub-Agent");
    });

    it("creates task via DB and returns taskId", async () => {
      const ctx = mockContext();
      (ctx.db.createTask as any).mockResolvedValue({ id: "task-uuid", status: "pending" });
      const tool = createAssignTaskTool(ctx);

      const result = await tool.execute(
        "call-1",
        { agent: "writer", task_type: "create", description: "写第1章", input_refs: [] },
        undefined as any,
        undefined,
      );

      expect(result.content[0].text).toContain("task-uuid");
      expect(result.content[0].text).toContain("writer");
      expect(result.details.taskId).toBe("task-uuid");
      expect(result.details.agent).toBe("writer");
      expect(ctx.db.createTask).toHaveBeenCalledWith({
        projectId: "test-project-id",
        agent: "writer",
        taskType: "create",
        description: "写第1章",
        inputRefs: [],
      });
    });

    it("sends input_refs to DB", async () => {
      const ctx = mockContext();
      (ctx.db.createTask as any).mockResolvedValue({ id: "t1", status: "pending" });
      const tool = createAssignTaskTool(ctx);

      await tool.execute(
        "call-2",
        {
          agent: "character_designer",
          task_type: "revise",
          description: "修改",
          input_refs: [{ type: "character", path: "chars/test.md" }],
        },
        undefined as any,
        undefined,
      );

      expect(ctx.db.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          inputRefs: [{ type: "character", path: "chars/test.md" }],
        }),
      );
    });

    it("returns error on DB failure", async () => {
      const ctx = mockContext();
      (ctx.db.createTask as any).mockRejectedValue(new Error("db error"));
      const tool = createAssignTaskTool(ctx);

      const result = await tool.execute(
        "call-3",
        { agent: "writer", task_type: "create", description: "test", input_refs: [] },
        undefined as any,
        undefined,
      );

      expect(result.isError).toBe(true);
    });
  });

  describe("createApproveTaskTool", () => {
    it("has correct metadata", () => {
      const tool = createApproveTaskTool(mockContext());
      expect(tool.name).toBe("approve_task");
      expect(tool.label).toBe("Approve Task");
    });

    it("approves task with optional review note", async () => {
      const ctx = mockContext();
      const tool = createApproveTaskTool(ctx);

      const result = await tool.execute(
        "call-4",
        { task_id: "task-1", review_note: "不错" },
        undefined as any,
        undefined,
      );

      expect(result.content[0].text).toContain("approved");
      expect(ctx.db.updateTaskStatus).toHaveBeenCalledWith("task-1", "approved", "不错");
    });

    it("approves task without review note", async () => {
      const ctx = mockContext();
      const tool = createApproveTaskTool(ctx);

      await tool.execute("call-5", { task_id: "task-2" }, undefined as any, undefined);

      expect(ctx.db.updateTaskStatus).toHaveBeenCalledWith("task-2", "approved", undefined);
    });

    it("returns error on failure", async () => {
      const ctx = mockContext();
      (ctx.db.updateTaskStatus as any).mockRejectedValue(new Error("fail"));
      const tool = createApproveTaskTool(ctx);

      const result = await tool.execute("call-6", { task_id: "x" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
    });
  });

  describe("createRejectTaskTool", () => {
    it("has correct metadata", () => {
      const tool = createRejectTaskTool(mockContext());
      expect(tool.name).toBe("reject_task");
      expect(tool.label).toBe("Reject Task");
    });

    it("rejects task with required review note", async () => {
      const ctx = mockContext();
      const tool = createRejectTaskTool(ctx);

      const result = await tool.execute(
        "call-7",
        { task_id: "task-1", review_note: "需要更多细节" },
        undefined as any,
        undefined,
      );

      expect(result.content[0].text).toContain("rejected");
      expect(result.content[0].text).toContain("需要更多细节");
      expect(ctx.db.updateTaskStatus).toHaveBeenCalledWith("task-1", "rejected", "需要更多细节");
    });

    it("returns error on failure", async () => {
      const ctx = mockContext();
      (ctx.db.updateTaskStatus as any).mockRejectedValue(new Error("fail"));
      const tool = createRejectTaskTool(ctx);

      const result = await tool.execute("call-8", { task_id: "x", review_note: "bad" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
    });
  });

  describe("createTaskTools", () => {
    it("returns 3 task tools", () => {
      const tools = createTaskTools(mockContext());
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name).sort()).toEqual(["approve_task", "assign_task", "reject_task"]);
    });
  });
});
