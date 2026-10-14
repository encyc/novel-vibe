import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./file-tools.js";
import { validateInteractionRequest, validateRunPlan } from "../interactions/validation.js";

const optionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

const fieldBase = {
  id: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
  required: Type.Boolean(),
};

const fieldSchema = Type.Union([
  Type.Object({ ...fieldBase, type: Type.Literal("radio"), options: Type.Array(optionSchema) }),
  Type.Object({
    ...fieldBase,
    type: Type.Literal("checkbox"),
    min_selections: Type.Optional(Type.Integer()),
    max_selections: Type.Optional(Type.Integer()),
    options: Type.Array(optionSchema),
  }),
  Type.Object({
    ...fieldBase,
    type: Type.Union([Type.Literal("text"), Type.Literal("textarea")]),
    placeholder: Type.Optional(Type.String()),
    max_length: Type.Integer(),
  }),
]);

const updateRunPlanParams = Type.Object({
  id: Type.String({ description: "Stable machine id for this plan" }),
  title: Type.String(),
  items: Type.Array(Type.Object({
    id: Type.String(),
    title: Type.String(),
    status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
  })),
});

const requestInteractionParams = Type.Object({
  title: Type.String(),
  description: Type.Optional(Type.String()),
  fields: Type.Array(fieldSchema),
  references: Type.Optional(Type.Array(Type.Object({
    path: Type.String(),
    version_id: Type.String(),
    version_no: Type.Integer(),
    label: Type.Optional(Type.String()),
  }))),
  submit_label: Type.Optional(Type.String()),
  allow_free_answer: Type.Optional(Type.Boolean({ description: "Show an optional supplemental answer below preset choices" })),
});

type RequestParams = Static<typeof requestInteractionParams>;

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: true },
    isError: true,
  };
}

async function verifyReferences(ctx: ToolContext, references: RequestParams["references"]): Promise<void> {
  for (const reference of references ?? []) {
    const version = await ctx.db.getDocumentVersion(reference.version_id, ctx.projectId);
    if (!version
      || version.doc_path !== reference.path
      || version.version_no !== reference.version_no
      || version.state !== "complete") {
      throw new Error(`Unknown document version: ${reference.path}@${reference.version_no}`);
    }
  }
}

export function createInteractionTools(ctx: ToolContext): AgentTool<any>[] {
  const updateRunPlan: AgentTool<typeof updateRunPlanParams> = {
    name: "update_run_plan",
    label: "Update Run Plan",
    description: "Publish the complete current multi-step work plan. Use only for meaningful multi-step work.",
    parameters: updateRunPlanParams,
    execute: async (_toolCallId, params) => {
      try {
        const runPlan = validateRunPlan({ schemaVersion: 1, ...params });
        return { content: [{ type: "text", text: "Run plan updated." }], details: { runPlan } };
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  const requestInteraction: AgentTool<typeof requestInteractionParams> = {
    name: "request_user_interaction",
    label: "Request User Interaction",
    description: "Request necessary user input with a typed, reusable inline form. Do not duplicate the form in prose.",
    parameters: requestInteractionParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      try {
        if (!ctx.sessionId || !ctx.turnId || !ctx.assistantMessageId || !ctx.interactionRepository) {
          throw new Error("An active durable turn is required to request user interaction.");
        }
        await verifyReferences(ctx, params.references);
        const request = validateInteractionRequest({
          schemaVersion: 1,
          id: randomUUID(),
          title: params.title,
          description: params.description,
          fields: params.fields.map((field) => ({
            ...field,
            ...(field.type === "checkbox" ? {
              minSelections: field.min_selections,
              maxSelections: field.max_selections,
            } : {}),
            ...(field.type === "text" || field.type === "textarea" ? { maxLength: field.max_length } : {}),
            min_selections: undefined,
            max_selections: undefined,
            max_length: undefined,
          })),
          references: (params.references ?? []).map((reference) => ({
            path: reference.path,
            versionId: reference.version_id,
            versionNo: reference.version_no,
            label: reference.label,
          })),
          submitLabel: params.submit_label,
          allowFreeAnswer: params.allow_free_answer ?? true,
        });
        const stored = await ctx.interactionRepository.create({
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          assistantMessageId: ctx.assistantMessageId,
          request,
        });
        return {
          content: [{ type: "text", text: "Interaction requested. Wait for the user's structured response." }],
          details: { interaction: stored.request },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };

  return [updateRunPlan, requestInteraction];
}
