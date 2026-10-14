import { ArrowRight, FileText, MessageSquareText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { communityUrl } from "../config/public-origin";
import { formatNumber } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import { WorkspaceColophon } from "../workbench/WorkspaceColophon";
import { useUnsavedChanges } from "../workbench/UnsavedChangesGuard";
import { useWorkbench } from "../workbench/WorkbenchShell";
import { WORKBENCH_MODULES } from "../workbench/module-config";

export function ProjectOverviewPage() {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage);
  const { documents, documentsLoading, project } = useWorkbench();
  const { runAfterDiscard } = useUnsavedChanges();
  const navigate = useNavigate();
  const totalWords = documents.reduce((total, doc) => total + (doc.word_count ?? 0), 0);
  const recent = [...documents]
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, 6);

  function openDocument(docType: string, docPath: string) {
    // Guarded: an unsaved manuscript in the editor must never be dropped by
    // the "continue writing" shortcut.
    runAfterDiscard(() => {
      const module = WORKBENCH_MODULES.find((item) => item.documentTypes.includes(docType));
      navigate(`/projects/${project.id}/${module?.id ?? "chapters"}?document=${encodeURIComponent(docPath)}`);
    });
  }

  return (
    <div className="overview-page">
      <WorkspaceColophon eyebrow="PROJECT BRIEF · 00" title={project.title} detail={project.synopsis || t("workbench.overview.defaultDetail")}>
        {project.genre ? <span className="status-badge">{project.genre}</span> : null}
      </WorkspaceColophon>

      <section aria-label={t("workbench.overview.brief")} className="overview-brief">
        <section className="overview-metrics" aria-label={t("workbench.overview.statistics")}>
        <div><strong>{formatNumber(documents.length, locale)}</strong><span>{t("workbench.overview.documents")}</span></div>
        <div><strong>{formatNumber(totalWords, locale)}</strong><span>{t("workbench.overview.indexedWords")}</span></div>
        <div><strong>{formatNumber(documents.filter((doc) => doc.status === "locked").length, locale)}</strong><span>{t("workbench.overview.locked")}</span></div>
        </section>

        <section className="recent-documents">
        <div className="section-heading">
          <div><span className="page-eyebrow">{t("workbench.overview.recent")}</span><h2>{t("workbench.overview.continueWriting")}</h2></div>
          {documentsLoading ? <span>{t("workbench.overview.reading")}</span> : null}
        </div>
        <div className="recent-list">
          {recent.map((doc) => (
            <button key={doc.doc_path} onClick={() => openDocument(doc.doc_type, doc.doc_path)} type="button">
              <FileText size={17} />
              <span><strong>{doc.name || doc.doc_path.split("/").pop()}</strong><small>{doc.doc_path}</small></span>
              <small>{t("workbench.overview.words", { count: formatNumber(doc.word_count ?? 0, locale) })}</small>
            </button>
          ))}
          {!documentsLoading && !recent.length ? <p className="quiet-empty">{t("workbench.overview.empty")}</p> : null}
        </div>
        </section>

        <section className="overview-community-callout" aria-label={t("workbench.overview.communityRegion")}>
          <div>
            <span><MessageSquareText size={17} />{t("workbench.community")}</span>
            <h2>{t("workbench.overview.communityTitle")}</h2>
            <p>{t("workbench.overview.communityDetail")}</p>
          </div>
          <a href={communityUrl()}>{t("workbench.overview.enterCommunity")} <ArrowRight size={15} /></a>
        </section>
      </section>
    </div>
  );
}
