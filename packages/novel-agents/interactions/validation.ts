import type {
  InteractionAnswer,
  InteractionDocumentReference,
  InteractionField,
  InteractionOption,
  InteractionRequestV1,
  InteractionResponseV1,
  RunPlanItemStatus,
  RunPlanV1,
} from "./types.js";

const REQUEST_BYTES = 32 * 1024;
const RESPONSE_BYTES = 16 * 1024;
const MAX_FIELDS = 8;
const MAX_OPTIONS = 12;
const MAX_FREE_ANSWER = 2_000;

export class InteractionValidationError extends Error {
  constructor(message: string, public readonly fieldId?: string) {
    super(message);
    this.name = "InteractionValidationError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractionValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InteractionValidationError(`${label} must not be empty`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new InteractionValidationError(`${label} is too long`);
  return normalized;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, label, max);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new InteractionValidationError(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new InteractionValidationError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function assertJsonSize(value: unknown, max: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > max) {
    throw new InteractionValidationError(`${label} exceeds ${max} bytes`);
  }
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new InteractionValidationError(`${label} must be unique`);
}

function parseOption(value: unknown): InteractionOption {
  const input = record(value, "option");
  return {
    value: text(input.value, "option value", 128),
    label: text(input.label, "option label", 240),
    ...(optionalText(input.description, "option description", 1_000) ? { description: optionalText(input.description, "option description", 1_000) } : {}),
  };
}

function parseField(value: unknown): InteractionField {
  const input = record(value, "field");
  const id = text(input.id, "field id", 128);
  const label = text(input.label, "field label", 240);
  const description = optionalText(input.description, "field description", 1_000);
  const required = bool(input.required, "field required");
  const type = input.type;
  const base = { id, label, required, ...(description ? { description } : {}) };

  if (type === "radio" || type === "checkbox") {
    if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > MAX_OPTIONS) {
      throw new InteractionValidationError(`field ${id} must have 1-${MAX_OPTIONS} options`, id);
    }
    const options = input.options.map(parseOption);
    unique(options.map((option) => option.value), `option values for ${id}`);
    if (type === "radio") return { ...base, type, options };
    const minSelections = input.minSelections === undefined
      ? undefined
      : integer(input.minSelections, `${id} minSelections`, 0, options.length);
    const maxSelections = input.maxSelections === undefined
      ? undefined
      : integer(input.maxSelections, `${id} maxSelections`, 1, options.length);
    if (minSelections !== undefined && maxSelections !== undefined && minSelections > maxSelections) {
      throw new InteractionValidationError(`${id} minSelections exceeds maxSelections`, id);
    }
    return {
      ...base,
      type,
      options,
      ...(minSelections === undefined ? {} : { minSelections }),
      ...(maxSelections === undefined ? {} : { maxSelections }),
    };
  }

  if (type === "text" || type === "textarea") {
    const maxLength = integer(input.maxLength, `${id} maxLength`, 1, type === "text" ? 500 : 4_000);
    const placeholder = optionalText(input.placeholder, `${id} placeholder`, 240);
    return { ...base, type, maxLength, ...(placeholder ? { placeholder } : {}) };
  }
  throw new InteractionValidationError(`unsupported field type for ${id}`, id);
}

function parseReference(value: unknown): InteractionDocumentReference {
  const input = record(value, "reference");
  const label = optionalText(input.label, "reference label", 240);
  return {
    path: text(input.path, "reference path", 1_024),
    versionId: text(input.versionId, "reference versionId", 128),
    versionNo: integer(input.versionNo, "reference versionNo", 1, Number.MAX_SAFE_INTEGER),
    ...(label ? { label } : {}),
  };
}

export function validateInteractionRequest(value: unknown): InteractionRequestV1 {
  assertJsonSize(value, REQUEST_BYTES, "interaction request");
  const input = record(value, "interaction request");
  if (input.schemaVersion !== 1) throw new InteractionValidationError("unsupported interaction schemaVersion");
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > MAX_FIELDS) {
    throw new InteractionValidationError(`interaction must have 1-${MAX_FIELDS} fields`);
  }
  const fields = input.fields.map(parseField);
  unique(fields.map((field) => field.id), "field ids");
  if (input.references !== undefined && !Array.isArray(input.references)) {
    throw new InteractionValidationError("references must be an array");
  }
  const references = (input.references ?? []).map(parseReference);
  const description = optionalText(input.description, "interaction description", 2_000);
  const submitLabel = optionalText(input.submitLabel, "submit label", 120);
  return {
    schemaVersion: 1,
    id: text(input.id, "interaction id", 128),
    title: text(input.title, "interaction title", 240),
    ...(description ? { description } : {}),
    fields,
    references,
    ...(submitLabel ? { submitLabel } : {}),
    allowFreeAnswer: input.allowFreeAnswer === undefined ? true : bool(input.allowFreeAnswer, "allowFreeAnswer"),
  };
}

function parseAnswer(field: InteractionField, value: unknown): InteractionAnswer {
  const input = record(value, `answer ${field.id}`);
  if (input.type !== field.type) throw new InteractionValidationError(`answer type mismatch for ${field.id}`, field.id);
  if (field.type === "checkbox") {
    if (!Array.isArray(input.value) || input.value.some((item) => typeof item !== "string")) {
      throw new InteractionValidationError(`answer for ${field.id} must be a string array`, field.id);
    }
    const selections = [...input.value] as string[];
    unique(selections, `selections for ${field.id}`);
    const allowed = new Set(field.options.map((option) => option.value));
    if (selections.some((selection) => !allowed.has(selection))) {
      throw new InteractionValidationError(`answer for ${field.id} contains an unknown option`, field.id);
    }
    const minimum = field.required ? Math.max(1, field.minSelections ?? 0) : field.minSelections ?? 0;
    if (selections.length < minimum || (field.maxSelections !== undefined && selections.length > field.maxSelections)) {
      throw new InteractionValidationError(`answer for ${field.id} violates selection bounds`, field.id);
    }
    return { fieldId: field.id, type: field.type, value: selections };
  }
  if (typeof input.value !== "string") throw new InteractionValidationError(`answer for ${field.id} must be text`, field.id);
  const answer = input.value.trim();
  if (field.required && !answer) throw new InteractionValidationError(`answer for ${field.id} is required`, field.id);
  if ((field.type === "text" || field.type === "textarea") && answer.length > field.maxLength) {
    throw new InteractionValidationError(`answer for ${field.id} is too long`, field.id);
  }
  if (field.type === "radio" && !field.options.some((option) => option.value === answer)) {
    throw new InteractionValidationError(`answer for ${field.id} contains an unknown option`, field.id);
  }
  return { fieldId: field.id, type: field.type, value: answer };
}

export function validateInteractionResponse(requestValue: unknown, value: unknown): InteractionResponseV1 {
  assertJsonSize(value, RESPONSE_BYTES, "interaction response");
  const request = validateInteractionRequest(requestValue);
  const input = record(value, "interaction response");
  if (input.schemaVersion !== 1) throw new InteractionValidationError("unsupported response schemaVersion");
  const interactionId = text(input.interactionId, "interactionId", 128);
  if (interactionId !== request.id) throw new InteractionValidationError("interactionId does not match request");
  if (!Array.isArray(input.answers)) throw new InteractionValidationError("answers must be an array");
  const rawAnswers = input.answers;
  const byId = new Map(request.fields.map((field) => [field.id, field]));
  const rawIds = rawAnswers.map((answer) => text(record(answer, "answer").fieldId, "answer fieldId", 128));
  unique(rawIds, "answer field ids");
  for (const id of rawIds) if (!byId.has(id)) throw new InteractionValidationError(`unknown field ${id}`, id);
  const rawById = new Map(rawIds.map((id, index) => [id, rawAnswers[index]]));
  const answers: InteractionAnswer[] = [];
  for (const field of request.fields) {
    const raw = rawById.get(field.id);
    if (raw === undefined) {
      if (field.required) throw new InteractionValidationError(`answer for ${field.id} is required`, field.id);
      continue;
    }
    answers.push(parseAnswer(field, raw));
  }
  const freeAnswer = optionalText(input.freeAnswer, "free answer", MAX_FREE_ANSWER);
  if (freeAnswer && !request.allowFreeAnswer) throw new InteractionValidationError("free answer is not enabled");
  return {
    schemaVersion: 1,
    interactionId,
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey", 128),
    answers,
    ...(freeAnswer ? { freeAnswer } : {}),
  };
}

export function validateRunPlan(value: unknown): RunPlanV1 {
  const input = record(value, "run plan");
  if (input.schemaVersion !== 1) throw new InteractionValidationError("unsupported plan schemaVersion");
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 8) {
    throw new InteractionValidationError("run plan must have 1-8 items");
  }
  const allowed = new Set<RunPlanItemStatus>(["pending", "in_progress", "completed"]);
  const items = input.items.map((value) => {
    const item = record(value, "run plan item");
    if (!allowed.has(item.status as RunPlanItemStatus)) throw new InteractionValidationError("invalid run plan item status");
    return {
      id: text(item.id, "run plan item id", 128),
      title: text(item.title, "run plan item title", 240),
      status: item.status as RunPlanItemStatus,
    };
  });
  unique(items.map((item) => item.id), "run plan item ids");
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    throw new InteractionValidationError("run plan cannot have multiple in-progress items");
  }
  return {
    schemaVersion: 1,
    id: text(input.id, "run plan id", 128),
    title: text(input.title, "run plan title", 240),
    items,
  };
}
