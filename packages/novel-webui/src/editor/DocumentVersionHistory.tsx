import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocumentVersionSummary } from "../types";

interface DocumentVersionHistoryProps {
  versions: DocumentVersionSummary[];
  selectedVersionId: string | null;
  hasMore: boolean;
  loading: boolean;
  onSelect(versionId: string): void;
  onLoadMore(): void;
}

export function DocumentVersionHistory(props: DocumentVersionHistoryProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const sourceLabel = (version: DocumentVersionSummary) => {
    if (version.sourceType === "user") return t("workbench.document.versions.source.user");
    if (version.sourceType === "system") return t("workbench.document.versions.source.system");
    return t(`workbench.document.versions.source.agents.${version.agentId ?? "chief_editor"}`);
  };
  return (
    <aside aria-label={t("workbench.document.versions.history")} className="document-version-history">
      <header>
        <h2>{t("workbench.document.versions.history")}</h2>
        <button
          aria-expanded={expanded}
          className="document-version-history-toggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >{expanded ? t("workbench.document.versions.hideHistory") : t("workbench.document.versions.showHistory")}</button>
      </header>
      <div className={`document-version-history-content${expanded ? " is-expanded" : " is-collapsed"}`}>
        <ol>
          {props.versions.map((version) => {
          const label = `${sourceLabel(version)} · ${t("workbench.document.versions.version", { version: version.versionNo })} · ${t("workbench.document.versions.stats", { added: version.addedLines, deleted: version.deletedLines })}`;
          return (
            <li key={version.id}>
              <button aria-current={version.id === props.selectedVersionId ? "true" : undefined} aria-label={label} onClick={() => props.onSelect(version.id)} type="button">
                <span><strong>{sourceLabel(version)}</strong><span>{t("workbench.document.versions.version", { version: version.versionNo })}</span></span>
                <span>{t("workbench.document.versions.stats", { added: version.addedLines, deleted: version.deletedLines })}</span>
                <time dateTime={version.createdAt}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(new Date(version.createdAt))}</time>
              </button>
              {version.diffStatus === "unavailable" ? <small>{t("workbench.document.versions.repair")}</small> : null}
            </li>
          );
          })}
        </ol>
        {props.hasMore ? <button disabled={props.loading} onClick={props.onLoadMore} type="button">{t("workbench.document.versions.loadOlder")}</button> : null}
      </div>
    </aside>
  );
}
