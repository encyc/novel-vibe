/**
 * Task tools for the Chief Editor agent to coordinate sub-agents.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./file-tools.js";

// ─── assign_task ──────────────────────────────────────────────────

const assignTaskParams = Type.Object({
  agent: Type.Union([
    Type.Literal("worldbuilder"),
    Type.Literal("character_designer"),
    Type.Literal("outliner"),
    Type.Literal("director"),
    Type.Literal("writer"),
    Type.Literal("script_supervisor"),
  ], { description: "Target sub-agent" }),
  task_type: Type.Union([
    Type.Literal("create"),
    Type.Literal("revise"),
    Type.Literal("review"),
  ], { description: "Type of task" }),
  description: Type.String({ description: "Task description for the sub-agent" }),
  input_refs: Type.Array(Type.Object({
    type: Type.String(),
    path: Type.String(),
  }), { description: "Input documents to reference", default: [] }),
});

export function createAssignTaskTool(ctx: ToolContext): AgentTool<typeof assignTaskParams> {
  return {
    name: "assign_task",
    label: "Assign Task to Sub-Agent",
    description: "Assign a task to a specialized sub-agent. Returns the task ID for tracking.",
    parameters: assignTaskParams,
    execute: async (_, params) => {
      try {
        const task = await ctx.db.createTask({
          projectId: ctx.projectId,
          agent: params.agent,
          taskType: params.task_type,
          description: params.description,
          inputRefs: params.input_refs,
        });

        return {
          content: [{
            type: "text" as const,
            text: `Task assigned to ${params.agent}: [${task.id}] ${params.task_type} — ${params.description}\nStatus: ${task.status}`,
          }],
          details: { taskId: task.id, agent: params.agent, status: task.status },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Task assignment error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── approve_task ─────────────────────────────────────────────────

const approveTaskParams = Type.Object({
  task_id: Type.String({ description: "Task ID to approve" }),
  review_note: Type.Optional(Type.String({ description: "Optional review note" })),
});

export function createApproveTaskTool(ctx: ToolContext): AgentTool<typeof approveTaskParams> {
  return {
    name: "approve_task",
    label: "Approve Task",
    description: "Approve a sub-agent's task output and mark it as confirmed.",
    parameters: approveTaskParams,
    execute: async (_, params) => {
      try {
        await ctx.db.updateTaskStatus(params.task_id, "approved", params.review_note);
        return {
          content: [{ type: "text" as const, text: `Task ${params.task_id} approved.` }],
          details: { taskId: params.task_id, status: "approved" },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Approve error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── reject_task ──────────────────────────────────────────────────

const rejectTaskParams = Type.Object({
  task_id: Type.String({ description: "Task ID to reject" }),
  review_note: Type.String({ description: "Reason for rejection, with specific feedback" }),
});

export function createRejectTaskTool(ctx: ToolContext): AgentTool<typeof rejectTaskParams> {
  return {
    name: "reject_task",
    label: "Reject Task",
    description: "Reject a sub-agent's task output with feedback for revision.",
    parameters: rejectTaskParams,
    execute: async (_, params) => {
      try {
        await ctx.db.updateTaskStatus(params.task_id, "rejected", params.review_note);
        return {
          content: [{ type: "text" as const, text: `Task ${params.task_id} rejected. Feedback: ${params.review_note}` }],
          details: { taskId: params.task_id, status: "rejected" },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Reject error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── Convenience ──────────────────────────────────────────────────

export function createTaskTools(ctx: ToolContext): AgentTool<any>[] {
  return [createAssignTaskTool(ctx), createApproveTaskTool(ctx), createRejectTaskTool(ctx)];
}
