import { FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InteractionAnswer, InteractionResponseV1, SessionInteraction } from "../types";
import { InteractionField } from "./InteractionField";
import {
  buildInteractionResponse,
  initialInteractionAnswers,
  updateInteractionAnswer,
  validateInteractionAnswers,
  type InteractionAnswers,
} from "./interaction-state";

interface Props {
  interaction: SessionInteraction;
  disabled?: boolean;
  onSubmit: (response: InteractionResponseV1) => Promise<void> | void;
}

function responseLabel(interaction: SessionInteraction, answer: InteractionAnswer): string {
  const field = interaction.request.fields.find((candidate) => candidate.id === answer.fieldId);
  if (!field) return answer.fieldId;
  if (field.type === "radio" && typeof answer.value === "string") {
    return field.options.find((option) => option.value === answer.value)?.label ?? answer.value;
  }
  if (field.type === "checkbox" && Array.isArray(answer.value)) {
    return answer.value.map((value) => field.options.find((option) => option.value === value)?.label ?? value).join("、");
  }
  return String(answer.value);
}

export function InteractionCard({ interaction, disabled = false, onSubmit }: Props) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<InteractionAnswers>(() => initialInteractionAnswers(interaction.request));
  const [freeAnswer, setFreeAnswer] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());

  const errorText = (code: string) => {
    if (code === "required") return t("assistant.interaction.required");
    if (code.startsWith("min:")) return t("assistant.interaction.min", { count: Number(code.slice(4)) });
    if (code.startsWith("max:")) return t("assistant.interaction.max", { count: Number(code.slice(4)) });
    if (code.startsWith("maxLength:")) return t("assistant.interaction.maxLength", { count: Number(code.slice(10)) });
    return t("assistant.interaction.invalid");
  };

  if (interaction.status === "resolved" && interaction.response) {
    return (
      <section aria-label={interaction.request.title} className="interaction-card resolved">
        <header><div><strong>{interaction.request.title}</strong><span>{t("assistant.interaction.answered")}</span></div></header>
        <dl>
          {interaction.response.answers.map((answer) => (
            <div key={answer.fieldId}><dt>{interaction.request.fields.find((field) => field.id === answer.fieldId)?.label ?? answer.fieldId}</dt><dd>{responseLabel(interaction, answer)}</dd></div>
          ))}
          {interaction.response.freeAnswer ? <div><dt>{t("assistant.interaction.freeAnswer")}</dt><dd>{interaction.response.freeAnswer}</dd></div> : null}
        </dl>
      </section>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const validation = validateInteractionAnswers(interaction.request, answers);
    setErrors(validation);
    setSubmitError(false);
    if (Object.keys(validation).length) return;
    setSubmitting(true);
    try {
      await onSubmit(buildInteractionResponse(interaction.request, answers, freeAnswer, idempotencyKey.current));
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form aria-label={interaction.request.title} className="interaction-card" onSubmit={submit}>
      <header>
        <div><strong>{interaction.request.title}</strong>{interaction.request.description ? <p>{interaction.request.description}</p> : null}</div>
      </header>
      {interaction.request.references.length ? (
        <ul className="interaction-references">
          {interaction.request.references.map((reference) => <li key={reference.versionId}>{reference.label ?? reference.path} · v{reference.versionNo}</li>)}
        </ul>
      ) : null}
      <div className="interaction-fields">
        {interaction.request.fields.map((field) => (
          <InteractionField
            disabled={disabled || submitting}
            error={errors[field.id]}
            errorText={errorText}
            field={field}
            key={field.id}
            onChange={(value) => {
              setAnswers((current) => updateInteractionAnswer(current, field.id, value));
              setErrors((current) => ({ ...current, [field.id]: "" }));
            }}
            value={answers[field.id]}
          />
        ))}
        {interaction.request.allowFreeAnswer ? (
          <label className="interaction-free-answer">
            <span>{t("assistant.interaction.freeAnswerOptional")}</span>
            <textarea disabled={disabled || submitting} maxLength={2000} onChange={(event) => setFreeAnswer(event.target.value)} placeholder={t("assistant.interaction.freeAnswerPlaceholder")} rows={3} value={freeAnswer} />
          </label>
        ) : null}
      </div>
      {submitError ? <p className="interaction-submit-error" role="alert">{t("assistant.interaction.submitFailed")}</p> : null}
      <footer>
        {disabled ? <span>{t("assistant.interaction.readOnly")}</span> : null}
        <button disabled={disabled || submitting} type="submit">{submitting ? t("assistant.interaction.submitting") : interaction.request.submitLabel ?? t("assistant.interaction.submit")}</button>
      </footer>
    </form>
  );
}
