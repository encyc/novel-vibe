import type { InteractionField as InteractionFieldType } from "../types";
import type { InteractionAnswerValue } from "./interaction-state";

interface Props {
  field: InteractionFieldType;
  value: InteractionAnswerValue;
  error?: string;
  disabled?: boolean;
  onChange: (value: InteractionAnswerValue) => void;
  errorText: (code: string) => string;
}

export function InteractionField({ field, value, error, disabled, onChange, errorText }: Props) {
  const errorId = `interaction-${field.id}-error`;
  if (field.type === "radio" || field.type === "checkbox") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset aria-describedby={error ? errorId : undefined} className="interaction-field" disabled={disabled}>
        <legend>{field.label}{field.required ? <span aria-hidden="true"> *</span> : null}</legend>
        {field.description ? <p>{field.description}</p> : null}
        <div className="interaction-options">
          {field.options.map((option) => {
            const checked = field.type === "radio" ? value === option.value : selected.includes(option.value);
            return (
              <label className="interaction-option" data-selected={checked} key={option.value}>
                <input
                  checked={checked}
                  name={field.id}
                  onChange={(event) => {
                    if (field.type === "radio") onChange(option.value);
                    else onChange(event.currentTarget.checked
                      ? [...selected, option.value]
                      : selected.filter((item) => item !== option.value));
                  }}
                  type={field.type}
                  value={option.value}
                />
                <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
              </label>
            );
          })}
        </div>
        {error ? <span className="interaction-error" id={errorId}>{errorText(error)}</span> : null}
      </fieldset>
    );
  }

  return (
    <label className="interaction-field interaction-text-field">
      <span>{field.label}{field.required ? <span aria-hidden="true"> *</span> : null}</span>
      {field.description ? <small>{field.description}</small> : null}
      {field.type === "textarea" ? (
        <textarea aria-describedby={error ? errorId : undefined} disabled={disabled} maxLength={field.maxLength} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} rows={3} value={typeof value === "string" ? value : ""} />
      ) : (
        <input aria-describedby={error ? errorId : undefined} disabled={disabled} maxLength={field.maxLength} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} type="text" value={typeof value === "string" ? value : ""} />
      )}
      {error ? <span className="interaction-error" id={errorId}>{errorText(error)}</span> : null}
    </label>
  );
}
