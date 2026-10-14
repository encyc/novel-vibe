import type { InteractionAnswer, InteractionRequestV1, InteractionResponseV1 } from "../types";

export type InteractionAnswerValue = string | string[];
export type InteractionAnswers = Record<string, InteractionAnswerValue>;
export type InteractionErrors = Record<string, string>;

export function initialInteractionAnswers(request: InteractionRequestV1): InteractionAnswers {
  return Object.fromEntries(request.fields.map((field) => [field.id, field.type === "checkbox" ? [] : ""]));
}

export function updateInteractionAnswer(answers: InteractionAnswers, fieldId: string, value: InteractionAnswerValue): InteractionAnswers {
  return { ...answers, [fieldId]: Array.isArray(value) ? [...value] : value };
}

export function validateInteractionAnswers(request: InteractionRequestV1, answers: InteractionAnswers): InteractionErrors {
  const errors: InteractionErrors = {};
  for (const field of request.fields) {
    const value = answers[field.id];
    if (field.type === "checkbox") {
      const selections = Array.isArray(value) ? value : [];
      const minimum = field.required ? Math.max(1, field.minSelections ?? 0) : field.minSelections ?? 0;
      if (selections.length < minimum) errors[field.id] = minimum === 1 ? "required" : `min:${minimum}`;
      else if (field.maxSelections !== undefined && selections.length > field.maxSelections) errors[field.id] = `max:${field.maxSelections}`;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (field.required && !text) errors[field.id] = "required";
    else if ((field.type === "text" || field.type === "textarea") && text.length > field.maxLength) errors[field.id] = `maxLength:${field.maxLength}`;
    else if (field.type === "radio" && text && !field.options.some((option) => option.value === text)) errors[field.id] = "invalid";
  }
  return errors;
}

export function buildInteractionResponse(
  request: InteractionRequestV1,
  answers: InteractionAnswers,
  freeAnswer: string,
  idempotencyKey: string,
): InteractionResponseV1 {
  const output: InteractionAnswer[] = [];
  for (const field of request.fields) {
    const value = answers[field.id];
    if (field.type === "checkbox") {
      if (Array.isArray(value) && value.length) output.push({ fieldId: field.id, type: field.type, value: [...value] });
    } else if (typeof value === "string" && value.trim()) {
      output.push({ fieldId: field.id, type: field.type, value: value.trim() });
    }
  }
  const supplemental = freeAnswer.trim();
  return {
    schemaVersion: 1,
    interactionId: request.id,
    idempotencyKey,
    answers: output,
    ...(supplemental ? { freeAnswer: supplemental } : {}),
  };
}
