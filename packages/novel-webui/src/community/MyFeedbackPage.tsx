import { useQuery } from "@tanstack/react-query";
import { BookOpenText } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { appUrl } from "../config/public-origin";
import { formatNumber } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import type { User } from "../types";

interface MyFeedbackPageProps {
  user: User | null;
  onSignedOut: () => void;
}

export function MyFeedbackPage({ user }: MyFeedbackPageProps) {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage ?? i18n.language);
  const query = useQuery({
    queryKey: ["community-my-feedback"],
    queryFn: () => api.listMyCommunityFeedback(),
    enabled: Boolean(user),
  });

  if (!user) {
    return <main className="community-page"><div className="community-empty">{t("community.feedback.signInRequired")}</div></main>;
  }

  const items = query.data?.items ?? [];

  return (
    <main className="community-page">
      <header className="community-topbar">
        <Link to="/community" className="community-topbar-brand">
          <span>← {t("community.back")}</span>
          <small>{t("community.labels.myFeedback")}</small>
        </Link>
        <div className="community-topbar-actions">
          <a href={appUrl("/projects")} className="community-nav-link"><BookOpenText size={16} />{t("community.workspace")}</a>
        </div>
      </header>
      <div className="community-content community-feedback-page">
        <h1 className="community-detail-title">{t("community.feedback.title")}</h1>
        {query.isLoading ? <div className="community-empty">{t("community.loading")}</div> : null}
        {query.isError ? <div className="community-empty">{t("community.feedback.loadFailed")}</div> : null}
        {!query.isLoading && !query.isError && items.length === 0 ? (
          <div className="community-empty">{t("community.feedback.empty")}</div>
        ) : null}
        <div className="community-article-grid community-feedback-list" role="list">
          {items.map((item) => (
            <Link className="community-article-card" key={item.id} role="listitem" to={`/community/${item.id}`}>
              <h3 className="community-article-card-title">{item.title}</h3>
              <div className="community-article-card-meta">
                <span>{t(`community.kinds.${item.kind}`)}</span>
                <span className="community-status-badge">{t(`community.feedbackStatus.${item.feedbackStatus ?? "open"}`)}</span>
              </div>
              <div className="community-article-card-stats">
                <span>{t(`community.actions.${item.kind === "bug" ? "encountered" : "vote"}`)} {formatNumber(item.likeCount, locale)}</span>
                <span>{t("community.actions.comments", { count: formatNumber(item.commentCount, locale) })}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
