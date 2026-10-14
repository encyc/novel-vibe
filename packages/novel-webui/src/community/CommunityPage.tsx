import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText, PenLine, Search, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { appUrl } from "../config/public-origin";
import { formatDate, formatNumber } from "../i18n/format";
import { InterfaceLanguageSelector } from "../i18n/InterfaceLanguageSelector";
import { normalizeInterfaceLocale } from "../i18n/locale";
import type { CommunityArticleSummary, CommunityKind, CommunitySort, User } from "../types";
import { AuthRequiredDialog } from "./AuthRequiredDialog";

interface CommunityPageProps {
  user: User | null;
  onSignedOut: () => void;
}

const COMMUNITY_TABS: CommunityKind[] = ["article", "bug", "feature_request", "announcement"];

export function CommunityPage({ user }: CommunityPageProps) {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage ?? i18n.language);
  const [kind, setKind] = useState<CommunityKind>("article");
  const [search, setSearch] = useState("");
  const [featuredOnly, setFeaturedOnly] = useState(false);
  const [sort, setSort] = useState<CommunitySort>("ranked");
  const [authPrompt, setAuthPrompt] = useState<{ title: string; message: string } | null>(null);

  const articlesQuery = useQuery({
    queryKey: ["community-articles", { kind, search, featuredOnly, sort }],
    queryFn: () => api.listCommunityArticles({
      kind,
      sort: kind === "announcement" ? "latest" : sort,
      search: search.trim() || undefined,
      featured: kind === "article" && featuredOnly ? true : undefined,
    }),
  });

  const articles = articlesQuery.data?.items ?? [];
  const actionLabel = (article: CommunityArticleSummary) => {
    const key = article.kind === "bug" ? "encountered" : article.kind === "feature_request" ? "vote" : "like";
    return `${t(`community.actions.${key}`)} ${formatNumber(article.likeCount, locale)}`;
  };
  const statusLabel = (article: CommunityArticleSummary) => article.feedbackStatus
    ? t(`community.feedbackStatus.${article.feedbackStatus}`)
    : article.isFeatured ? t("community.featured") : null;

  return (
    <main className="community-page">
      <header className="community-topbar">
        <Link to="/community" className="community-topbar-brand">
          <span>{t("community.brand")}</span>
          <small>{t("community.labels.board")}</small>
        </Link>
        <div className="community-topbar-actions">
          <InterfaceLanguageSelector authenticated={Boolean(user)} />
          <a href={appUrl("/projects")} className="community-nav-link"><BookOpenText size={16} />{t("community.workspace")}</a>
          {user ? (
            <Link to="/community/write" className="primary-button"><PenLine size={16} />{t("community.write")}</Link>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={() => setAuthPrompt({
                title: t("community.index.authTitle"),
                message: t("community.index.authMessage"),
              })}
            ><PenLine size={16} />{t("community.write")}</button>
          )}
        </div>
      </header>

      <div className="community-content">
        <section className="community-hero" aria-label={t("community.index.heroAria")}>
          <div className="community-title">
            <span className="community-kicker">{t("community.labels.hero")}</span>
            <h1>{t("community.index.title")}</h1>
            <p>{t("community.index.description")}</p>
          </div>
        </section>

        <div className="community-kind-tabs" aria-label={t("community.index.tabsAria")} role="tablist">
          {COMMUNITY_TABS.map((tab) => (
            <button
              aria-selected={kind === tab}
              className="community-kind-tab"
              key={tab}
              onClick={() => {
                setKind(tab);
                setFeaturedOnly(false);
              }}
              role="tab"
              type="button"
            >
              {t(`community.kindOptions.${tab}`)}
            </button>
          ))}
        </div>

        <div className="community-toolbar">
          <label className="community-search">
            <Search size={15} />
            <input
              aria-label={t("community.index.search")}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("community.index.search")}
              type="search"
              value={search}
            />
          </label>
          <label className="community-sort">
            <span>{t("community.index.sort")}</span>
            <select aria-label={t("community.index.sortAria")} disabled={kind === "announcement"} onChange={(event) => setSort(event.target.value as CommunitySort)} value={kind === "announcement" ? "latest" : sort}>
              <option value="ranked">{t("community.index.ranked")}</option>
              <option value="latest">{t("community.index.latest")}</option>
              <option value="popular">{t("community.index.popular")}</option>
            </select>
          </label>
          {kind === "article" ? (
            <button
              className="community-section-tab"
              data-active={featuredOnly}
              onClick={() => setFeaturedOnly((current) => !current)}
              type="button"
            >
              <Sparkles size={14} />{t("community.index.featuredOnly")}
            </button>
          ) : null}
          {user ? (
            <Link className="community-nav-link community-feedback-link" to="/community/my-feedback">{t("community.index.myFeedback")}</Link>
          ) : null}
        </div>

        {articlesQuery.isLoading && <div className="community-empty">{t("community.loading")}</div>}
        {articlesQuery.isError && <div className="community-empty" role="alert"><strong>{t("community.index.loadFailed")}</strong><span>{t("community.index.loadFailedDetail")}</span><button className="secondary-button" onClick={() => articlesQuery.refetch()} type="button">{t("community.index.reload")}</button></div>}
        {!articlesQuery.isLoading && !articlesQuery.isError && articles.length === 0 && (
          <div className="community-empty">{t(search.trim() ? "community.index.noMatches" : "community.index.empty")}</div>
        )}

        <div className="community-article-grid" role="list">
          {articles.map((article) => (
            <Link
              key={article.id}
              to={`/community/${article.id}`}
              className="community-article-card"
              role="listitem"
            >
              <h3 className="community-article-card-title">{article.title}</h3>
              <div className="community-article-card-meta">
                <span>{article.author.nickname}</span>
                {article.author.isOfficial && <span className="community-official-badge">{t("community.official")}</span>}
                {article.author.isMember && <span className="community-member-badge">{t("community.member")}</span>}
                {statusLabel(article) && <span className="community-status-badge">{statusLabel(article)}</span>}
                <span>·</span>
                <span>{article.publishedAt ? formatDate(article.publishedAt, locale, { dateStyle: "medium" }) : ""}</span>
              </div>
              {article.excerpt && <p className="community-article-card-excerpt">{article.excerpt}</p>}
              {article.tags.length > 0 ? (
                <div className="community-article-tags" aria-label={t("community.tags")}>
                  {article.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
              ) : null}
              <div className="community-article-card-stats">
                <span>{actionLabel(article)}</span>
                {article.kind === "article" && <span>{t("community.actions.bookmarks", { count: formatNumber(article.bookmarkCount, locale) })}</span>}
                {article.kind !== "announcement" && <span>{t("community.actions.comments", { count: formatNumber(article.commentCount, locale) })}</span>}
              </div>
            </Link>
          ))}
        </div>
      </div>
      <AuthRequiredDialog
        open={!!authPrompt}
        onOpenChange={(open) => {
          if (!open) setAuthPrompt(null);
        }}
        title={authPrompt?.title ?? t("community.auth.defaultTitle")}
        message={authPrompt?.message ?? t("community.auth.defaultMessage")}
      />
    </main>
  );
}
