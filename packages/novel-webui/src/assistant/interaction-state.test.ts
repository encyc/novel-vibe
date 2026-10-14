import { describe, expect, it } from "vitest";
import type { InteractionRequestV1 } from "../types";
import {
  buildInteractionResponse,
  initialInteractionAnswers,
  updateInteractionAnswer,
  validateInteractionAnswers,
} from "./interaction-state";

const request: InteractionRequestV1 = {
  schemaVersion: 1,
  id: "interaction-1",
  title: "Direction",
  fields: [
    { id: "tone", type: "radio", label: "Tone", required: true, options: [{ value: "warm", label: "Warm" }] },
    { id: "motifs", type: "checkbox", label: "Motifs", required: true, minSelections: 1, maxSelections: 2, options: [{ value: "rain", label: "Rain" }, { value: "letters", label: "Letters" }] },
    { id: "note", type: "textarea", label: "Note", required: false, maxLength: 20 },
  ],
  references: [],
  allowFreeAnswer: true,
};

describe("interaction state", () => {
  it("initializes each field by its discriminant", () => {
    expect(initialInteractionAnswers(request)).toEqual({ tone: "", motifs: [], note: "" });
  });

  it("updates answers immutably", () => {
    const initial = initialInteractionAnswers(request);
    const next = updateInteractionAnswer(initial, "motifs", ["rain"]);
    expect(next).toEqual({ ...initial, motifs: ["rain"] });
    expect(initial.motifs).toEqual([]);
  });

  it("reports required and selection-bound errors", () => {
    expect(validateInteractionAnswers(request, initialInteractionAnswers(request))).toMatchObject({
      tone: expect.any(String), motifs: expect.any(String),
    });
    expect(validateInteractionAnswers(request, { tone: "warm", motifs: ["rain", "letters"], note: "x" })).toEqual({});
  });

  it("builds a typed payload including the optional free answer", () => {
    expect(buildInteractionResponse(request, { tone: "warm", motifs: ["rain"], note: "" }, "More nuance", "stable-key"))
      .toEqual({
        schemaVersion: 1,
        interactionId: "interaction-1",
        idempotencyKey: "stable-key",
        answers: [
          { fieldId: "tone", type: "radio", value: "warm" },
          { fieldId: "motifs", type: "checkbox", value: ["rain"] },
        ],
        freeAnswer: "More nuance",
      });
  });
});
