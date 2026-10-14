import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, LogIn, PenLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { appUrl } from "../config/public-origin";
import { formatDate, formatNumber } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import type { User } from "../types";

interface AuthorProfilePageProps {
  user: User | null;
  onSignedOut: () => void;
}

export function AuthorProfilePage({ user }: AuthorProfilePageProps) {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage ?? i18n.language);
  const { userId } = useParams<{ userId: string }>();
  const queryClient = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ["community-author-profile", userId],
    queryFn: () => api.getCommunityAuthorProfile(userId!),
    enabled: !!userId,
  });

  const articlesQuery = useQuery({
    queryKey: ["community-author-articles", userId],
    queryFn: () => api.listCommunityArticlesByAuthor(userId!),
    enabled: !!userId,
  });

  const followingQuery = useQuery({
    queryKey: ["community-following-state", userId],
    queryFn: () => api.getCommunityFollowingState(userId!),
    enabled: !!user && !!userId && user.id !== userId,
  });
  const isFollowing = followingQuery.data?.following ?? false;

  const followMutation = useMutation({
    mutationFn: () => api.followUser(userId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["community-author-profile", userId] });
      queryClient.invalidateQueries({ queryKey: ["community-following-state", userId] });
    },
  });
  const unfollowMutation = useMutation({
    mutationFn: () => api.unfollowUser(userId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["community-author-profile", userId] });
      queryClient.invalidateQueries({ queryKey: ["community-following-state", userId] });
    },
  });

  const handleFollowToggle = () => {
    if (isFollowing) {
      unfollowMutation.mutate();
    } else {
      followMutation.mutate();
    }
  };

  if (profileQuery.isLoading) return <main className="community-page"><div className="community-empty">{t("community.author.loading")}</div></main>;
  if (profileQuery.isError || !profileQuery.data) return <main className="community-page"><div className="community-empty">{t("community.author.notFound")}</div></main>;

  const profile = profileQuery.data.profile;
  const articles = articlesQuery.data?.items ?? [];
  const isSelf = user?.id === userId;

  return (
    <main className="community-page">
      <header className="community-topbar">
        <Link to="/community" className="community-topbar-brand">
          <span>← {t("community.back")}</span>
          <small>{t("community.labels.authorFile")}</small>
        </Link>
        <div className="community-topbar-actions">
          <a href={appUrl("/projects")} className="community-nav-link"><BookOpenText size={16} />{t("community.workspace")}</a>
          {user ? (
            <Link to="/community/write" className="primary-button"><PenLine size={16} />{t("community.write")}</Link>
          ) : (
            <a href={appUrl("/login")} className="primary-button"><LogIn size={16} />{t("community.signIn")}</a>
          )}
        </div>
      </header>

      <div className="community-content">
        <div className="community-author-header">
          <h1 className="community-author-name">
            {profile.nickname}
            {profile.isOfficial && <span className="community-official-badge">{t("community.official")}</span>}
            {profile.isMember && <span className="community-member-badge">{t("community.member")}</span>}
          </h1>
          {profile.bio && <p className="community-author-bio">{profile.bio}</p>}
          <div className="community-author-stats">
            <span>{t("community.author.articles", { count: formatNumber(profile.articleCount, locale) })}</span>
            <span>{t("community.author.followers", { count: formatNumber(profile.followerCount, locale) })}</span>
          </div>
          {user && !isSelf && (
            <button
              className={isFollowing ? "secondary-button" : "primary-button"}
              disabled={followMutation.isPending || unfollowMutation.isPending}
              onClick={handleFollowToggle}
            >{t(isFollowing ? "community.author.unfollow" : "community.author.follow")}</button>
          )}
        </div>

        <div className="community-article-grid">
          {articles.length === 0 && <div className="community-empty">{t("community.author.empty")}</div>}
          {articles.map((article) => (
            <Link key={article.id} to={`/community/${article.id}`} className="community-article-card">
              <h3 className="community-article-card-title">{article.title}</h3>
              <div className="community-article-card-meta">
                <span>{article.publishedAt ? formatDate(article.publishedAt, locale, { dateStyle: "medium" }) : ""}</span>
              </div>
              {article.excerpt && <p className="community-article-card-excerpt">{article.excerpt}</p>}
              <div className="community-article-card-stats">
                <span>👍 {formatNumber(article.likeCount, locale)}</span>
                <span>💬 {formatNumber(article.commentCount, locale)}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
