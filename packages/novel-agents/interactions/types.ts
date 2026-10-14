export interface InteractionOption {
  value: string;
  label: string;
  description?: string;
}

interface InteractionFieldBase {
  id: string;
  label: string;
  description?: string;
  required: boolean;
}

export type InteractionField =
  | (InteractionFieldBase & { type: "radio"; options: InteractionOption[] })
  | (InteractionFieldBase & {
      type: "checkbox";
      minSelections?: number;
      maxSelections?: number;
      options: InteractionOption[];
    })
  | (InteractionFieldBase & {
      type: "text" | "textarea";
      placeholder?: string;
      maxLength: number;
    });

export interface InteractionDocumentReference {
  path: string;
  versionId: string;
  versionNo: number;
  label?: string;
}

export interface InteractionRequestV1 {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  fields: InteractionField[];
  references: InteractionDocumentReference[];
  submitLabel?: string;
  /** Show a supplemental, optional free-form answer after preset choices. */
  allowFreeAnswer: boolean;
}

export type InteractionAnswer =
  | { fieldId: string; type: "radio" | "text" | "textarea"; value: string }
  | { fieldId: string; type: "checkbox"; value: string[] };

export interface InteractionResponseV1 {
  schemaVersion: 1;
  interactionId: string;
  idempotencyKey: string;
  answers: InteractionAnswer[];
  freeAnswer?: string;
}

export type RunPlanItemStatus = "pending" | "in_progress" | "completed";

export interface RunPlanV1 {
  schemaVersion: 1;
  id: string;
  title: string;
  items: Array<{ id: string; title: string; status: RunPlanItemStatus }>;
}

export type InteractionStatus = "pending" | "resolved" | "cancelled";

export interface SessionInteractionDto {
  id: string;
  assistantMessageId: string;
  request: InteractionRequestV1;
  status: InteractionStatus;
  response?: InteractionResponseV1;
  respondedAt?: string;
}
