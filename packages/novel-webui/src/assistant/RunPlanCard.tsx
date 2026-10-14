import { Check, Circle, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RunPlanV1 } from "../types";

export function RunPlanCard({ plan }: { plan: RunPlanV1 }) {
  const { t } = useTranslation();
  const completed = plan.items.filter((item) => item.status === "completed").length;
  return (
    <section aria-label={plan.title} className="assistant-run-plan" role="region">
      <header>
        <div><span>{t("assistant.plan.eyebrow")}</span><strong>{plan.title}</strong></div>
        <small>{t("assistant.plan.progress", { completed, total: plan.items.length })}</small>
      </header>
      <progress aria-label={t("assistant.plan.progressAria")} aria-valuemax={plan.items.length} aria-valuemin={0} aria-valuenow={completed} max={plan.items.length} value={completed} />
      <ol>
        {plan.items.map((item) => (
          <li data-status={item.status} key={item.id}>
            {item.status === "completed" ? <Check aria-hidden="true" size={13} /> : item.status === "in_progress" ? <LoaderCircle aria-hidden="true" className="assistant-plan-spinner" size={13} /> : <Circle aria-hidden="true" size={11} />}
            <span>{item.title}</span>
            <small>{t(`assistant.plan.${item.status}`)}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}
