import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AiModel } from "../types";

const STORAGE_KEY = "novel-vibe:assistant-model";

/** The sentinel value for "use the project default model" (no override). */
const DEFAULT_MODEL_VALUE = "";

export interface ModelSelection {
  provider: string;
  model: string;
}

/** Load the persisted selection id (provider:model) from localStorage. */
function loadModelSelectionId(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_MODEL_VALUE;
  } catch {
    return DEFAULT_MODEL_VALUE;
  }
}

function persistModelSelectionId(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // localStorage unavailable — selection still works for the session.
  }
}

function groupByProvider(models: AiModel[], otherProvider: string): { provider: string; label: string; models: AiModel[] }[] {
  const groups = new Map<string, AiModel[]>();
  const labels = new Map<string, string>();
  for (const model of models) {
    const key = model.provider || otherProvider;
    if (!labels.has(key)) labels.set(key, model.providerLabel || key);
    const list = groups.get(key);
    if (list) list.push(model);
    else groups.set(key, [model]);
  }
  return [...groups.entries()].map(([provider, list]) => ({ provider, label: labels.get(provider) ?? provider, models: list }));
}

interface ModelSelectorProps {
  models: AiModel[];
  value: string;
  onChange: (value: string) => void;
}

export function ModelSelector({ models, value, onChange }: ModelSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const grouped = useMemo(() => groupByProvider(models, t("assistant.model.otherProvider")), [models, t]);
  const selected = models.find((m) => m.id === value);
  const label = selected ? selected.name : t("assistant.model.projectDefault");

  return (
    <div ref={containerRef} className="model-selector" data-open={open || undefined}>
      <button
        type="button"
        className="model-selector-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("assistant.model.select")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-selector-label">{label}</span>
        <ChevronsUpDown size={13} />
      </button>
      {open ? (
        <div role="listbox" className="model-selector-menu" aria-label={t("assistant.model.available")}>
          <button
            type="button"
            role="option"
            aria-selected={value === DEFAULT_MODEL_VALUE}
            className="model-selector-option"
            onClick={() => { onChange(DEFAULT_MODEL_VALUE); setOpen(false); }}
          >
            <span>{t("assistant.model.projectDefault")}</span>
            {value === DEFAULT_MODEL_VALUE ? <Check size={14} /> : null}
          </button>
          {grouped.map((group) => (
            <div key={group.provider} className="model-selector-group" role="group" aria-label={group.provider}>
              <div className="model-selector-group-title">{group.label}</div>
              {group.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={value === m.id}
                  className="model-selector-option"
                  title={m.inputRate != null || m.outputRate != null
                    ? t("assistant.model.rates", { input: m.inputRate ?? 0, output: m.outputRate ?? 0 })
                    : undefined}
                  onClick={() => { onChange(m.id); setOpen(false); }}
                >
                  <span>{m.name}</span>
                  {value === m.id ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type { AiModel };

/** Resolve a persisted selection id into a provider+model pair (or null). */
export function resolveSelection(models: AiModel[], value: string): ModelSelection | null {
  if (!value) return null;
  const found = models.find((m) => m.id === value);
  if (!found) return null;
  return { provider: found.provider, model: found.model };
}

export function usePersistedModelSelection() {
  const [value, setValue] = useState(loadModelSelectionId);
  const update = (next: string) => {
    persistModelSelectionId(next);
    setValue(next);
  };
  return [value, update] as const;
}
