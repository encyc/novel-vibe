import { ChevronDown, ChevronUp, FileDiff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TraceDocumentChange } from "./chat-trace";

interface DocumentChangeCardProps {
  changes: TraceDocumentChange[];
  onOpen(path: string, versionId: string): void;
}

export function DocumentChangeCard({ changes, onOpen }: DocumentChangeCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const groups = new Map<string, TraceDocumentChange[]>();
  for (const change of changes) {
    const versions = groups.get(change.path) ?? [];
    versions.push(change);
    groups.set(change.path, versions);
  }
  for (const versions of groups.values()) versions.sort((a, b) => a.versionNo - b.versionNo);

  return (
    <section aria-label={t("assistant.documentChanges.region")} className="document-change-card">
      <header>
        <FileDiff aria-hidden="true" size={15} />
        <strong>{t("assistant.documentChanges.title", { count: groups.size })}</strong>
        <button
          aria-expanded={expanded}
          aria-label={expanded ? t("assistant.documentChanges.collapse") : t("assistant.documentChanges.preview")}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? <ChevronUp aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}
        </button>
      </header>
      {[...groups].map(([path, versions]) => {
        const sections = [...new Set(versions.flatMap((change) => change.changedSections))].slice(0, 3);
        return (
          <div className="document-change-group" key={path}>
            <span className="document-change-path">{path}</span>
            {versions.map((change) => (
              <div className="document-change-version" key={change.versionId}>
                <span>{t("assistant.documentChanges.version", { version: change.versionNo })}</span>
                <span>{t("assistant.documentChanges.stats", { added: change.addedLines, deleted: change.deletedLines })}</span>
                <button
                  aria-label={`${t("assistant.documentChanges.open")} ${path} ${t("assistant.documentChanges.version", { version: change.versionNo })}`}
                  onClick={() => onOpen(path, change.versionId)}
                  type="button"
                >
                  {t("assistant.documentChanges.open")}
                </button>
              </div>
            ))}
            {expanded && sections.length ? <p className="document-change-sections">{sections.join(" · ")}</p> : null}
          </div>
        );
      })}
    </section>
  );
}
