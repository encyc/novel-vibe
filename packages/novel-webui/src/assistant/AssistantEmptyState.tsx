import { ArrowRight, BookOpen, Compass, ScanSearch } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
  activeDocumentPath: string | null;
  writable: boolean;
  onStart: (message: string) => void;
}

export function AssistantEmptyState({ activeDocumentPath, writable, onStart }: Props) {
  const { t } = useTranslation();
  if (!writable) {
    return (
      <div className="assistant-empty">
        <strong>{t("assistant.emptyTitle")}</strong>
        <span>{t("assistant.emptyReadOnly")}</span>
      </div>
    );
  }
  const starters = [
    ...(activeDocumentPath ? [{ key: "continue", icon: BookOpen, prompt: t("assistant.starters.continuePrompt", { path: activeDocumentPath }) }] : []),
    { key: "motivation", icon: Compass, prompt: t("assistant.starters.motivationPrompt") },
    { key: "plot", icon: ArrowRight, prompt: t("assistant.starters.plotPrompt") },
    { key: "continuity", icon: ScanSearch, prompt: t("assistant.starters.continuityPrompt") },
  ] as const;
  return (
    <div className="assistant-empty assistant-empty-actions">
      <strong>{t("assistant.emptyTitle")}</strong>
      <span>{t("assistant.emptyDetail")}</span>
      <div>
        {starters.map(({ key, icon: Icon, prompt }) => (
          <button key={key} onClick={() => onStart(prompt)} type="button">
            <Icon aria-hidden="true" size={14} />
            <span>{t(`assistant.starters.${key}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
