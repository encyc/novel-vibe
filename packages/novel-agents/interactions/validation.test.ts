import { describe, expect, it } from "vitest";
import {
  InteractionValidationError,
  validateInteractionRequest,
  validateInteractionResponse,
  validateRunPlan,
} from "./validation.js";

const requestInput = {
  schemaVersion: 1 as const,
  id: "direction-1",
  title: "Choose the next direction",
  description: "Pick any useful constraints.",
  fields: [
    {
      id: "tone",
      type: "radio" as const,
      label: "Tone",
      required: true,
      options: [
        { value: "tense", label: "Tense" },
        { value: "warm", label: "Warm" },
      ],
    },
    {
      id: "motifs",
      type: "checkbox" as const,
      label: "Motifs",
      required: false,
      minSelections: 1,
      maxSelections: 2,
      options: [
        { value: "rain", label: "Rain" },
        { value: "letters", label: "Letters" },
      ],
    },
    {
      id: "constraint",
      type: "text" as const,
      label: "Constraint",
      required: false,
      maxLength: 80,
    },
  ],
  references: [
    { path: "chapters/001.md", versionId: "version-1", versionNo: 2, label: "Current chapter" },
  ],
  submitLabel: "Continue",
  allowFreeAnswer: true,
};

describe("interaction validation", () => {
  it("normalizes a mixed request and preserves the optional free-answer setting", () => {
    expect(validateInteractionRequest(requestInput)).toEqual(requestInput);
  });

  it.each([
    ["duplicate field ids", { ...requestInput, fields: [requestInput.fields[0], requestInput.fields[0]] }],
    ["duplicate option values", { ...requestInput, fields: [{ ...requestInput.fields[0], options: [{ value: "same", label: "A" }, { value: "same", label: "B" }] }] }],
    ["too many fields", { ...requestInput, fields: Array.from({ length: 9 }, (_, index) => ({ ...requestInput.fields[2], id: `f-${index}` })) }],
    ["empty labels", { ...requestInput, fields: [{ ...requestInput.fields[0], label: "  " }] }],
  ])("rejects %s", (_label, input) => {
    expect(() => validateInteractionRequest(input)).toThrow(InteractionValidationError);
  });

  it("validates response types, memberships, bounds, text length, and free answer", () => {
    expect(validateInteractionResponse(requestInput, {
      schemaVersion: 1,
      interactionId: "direction-1",
      idempotencyKey: "retry-key-1",
      answers: [
        { fieldId: "tone", type: "radio", value: "tense" },
        { fieldId: "motifs", type: "checkbox", value: ["rain"] },
        { fieldId: "constraint", type: "text", value: "One room only" },
      ],
      freeAnswer: "Let the ending remain ambiguous.",
    })).toMatchObject({ interactionId: "direction-1", freeAnswer: "Let the ending remain ambiguous." });

    expect(() => validateInteractionResponse(requestInput, {
      schemaVersion: 1,
      interactionId: "direction-1",
      idempotencyKey: "retry-key-2",
      answers: [{ fieldId: "tone", type: "radio", value: "unknown" }],
    })).toThrow(InteractionValidationError);
  });

  it("rejects unknown response fields rather than ignoring them", () => {
    expect(() => validateInteractionResponse(requestInput, {
      schemaVersion: 1,
      interactionId: "direction-1",
      idempotencyKey: "retry-key-3",
      answers: [
        { fieldId: "tone", type: "radio", value: "warm" },
        { fieldId: "surprise", type: "text", value: "x" },
      ],
    })).toThrow(/unknown field/i);
  });
});

describe("run plan validation", () => {
  it("accepts one active item", () => {
    expect(validateRunPlan({
      schemaVersion: 1,
      id: "draft-chapter",
      title: "Draft chapter",
      items: [
        { id: "inspect", title: "Inspect context", status: "completed" },
        { id: "draft", title: "Draft scene", status: "in_progress" },
        { id: "review", title: "Review continuity", status: "pending" },
      ],
    }).items).toHaveLength(3);
  });

  it("rejects duplicate ids and multiple active items", () => {
    expect(() => validateRunPlan({
      schemaVersion: 1,
      id: "p",
      title: "Plan",
      items: [
        { id: "same", title: "A", status: "in_progress" },
        { id: "same", title: "B", status: "in_progress" },
      ],
    })).toThrow(InteractionValidationError);
  });
});
