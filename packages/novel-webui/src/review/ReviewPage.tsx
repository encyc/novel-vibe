import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionMessage } from "../types";
import { DocumentDiffViewer } from "../editor/DocumentDiffViewer";
import { useDocumentVersionDiff } from "../editor/useDocumentVersionDiff";
import { Spinner } from "../ui/Spinner";
import { deriveReviewGroups } from "./review-changes";

interface ReviewPageProps {
  messages: SessionMessage[];
  /** Version requested from the conversation; opens its diff directly. */
  focusVersionId?: string | null;
}

/**
 * Session-scoped change review: every document write the Chief Editor's run
 * produced, grouped per conversation turn (newest first), with an in-place
 * unified diff reader.
 */
export function ReviewPage({ focusVersionId, messages }: ReviewPageProps) {
  const { t } = useTranslation();
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  useEffect(() => {
    if (focusVersionId) setSelectedVersionId(focusVersionId);
  }, [focusVersionId]);

  const groups = deriveReviewGroups(messages);
  const {
    diffFailed,
    diffHasMore,
    diffLoading,
    diffPages,
    loadMoreDiff,
    version,
  } = useDocumentVersionDiff(selectedVersionId);

  if (!groups.length) {
    return (
      <div className="review-page">
        <ReviewHeader />
        <div className="workspace-empty">
          <strong>{t("workbench.review.emptyTitle")}</strong>
          <p>{t("workbench.review.emptyDetail")}</p>
        </div>
      </div>
    );
  }

  if (selectedVersionId && !version) {
    return (
      <div className="review-page">
        <ReviewHeader />
        <div className="workspace-empty"><Spinner label={t("workbench.document.versions.loading")} /></div>
      </div>
    );
  }

  if (selectedVersionId && version) {
    return (
      <div className="review-page">
        <ReviewHeader />
        <div className="review-diff-wrap">
          <button className="secondary-button review-back" onClick={() => setSelectedVersionId(null)} type="button">
            <ArrowLeft size={14} />{t("workbench.review.backToList")}
          </button>
          {version.diffStatus === "unavailable" || diffFailed ? (
            <div className="workspace-error" role="alert"><p>{t("workbench.document.versions.diffFailed")}</p></div>
          ) : (
            <DocumentDiffViewer
              error={undefined}
              hasMore={diffHasMore}
              loading={diffLoading}
              onClose={() => setSelectedVersionId(null)}
              onLoadMore={loadMoreDiff}
              pages={diffPages}
              version={version}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="review-page">
      <ReviewHeader />
      <div className="review-groups">
        {groups.map((group) => (
          <section aria-label={group.prompt || t("assistant.chiefEditor")} className="review-group" key={group.turnId}>
            <header>
              <strong>{group.prompt || t("workbench.review.unnamedTurn")}</strong>
              {group.status === "running" ? <span>{t("assistant.thinking")}</span> : null}
            </header>
            <ul>
              {group.changes.map((change) => (
                <li key={change.versionId}>
                  <button onClick={() => setSelectedVersionId(change.versionId)} type="button">
                    <code>{change.path}</code>
                    <small>{t("workbench.document.versions.stats", {
                      added: change.addedLines,
                      deleted: change.deletedLines,
                    })}</small>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function ReviewHeader() {
  const { t } = useTranslation();
  return (
    <header className="review-header">
      <h2>{t("workbench.review.title")}</h2>
      <p>{t("workbench.review.subtitle")}</p>
    </header>
  );
}
