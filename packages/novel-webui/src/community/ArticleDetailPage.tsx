import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, LogIn, PenLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { appUrl } from "../config/public-origin";
import { MarkdownPreview } from "../editor/MarkdownPreview";
import { formatDate, formatNumber } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import type { CommunityFeedbackStatus, User } from "../types";
import { AuthRequiredDialog } from "./AuthRequiredDialog";

interface ArticleDetailPageProps {
  user: User | null;
  onSignedOut: () => void;
}

export function ArticleDetailPage({ user }: ArticleDetailPageProps) {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage ?? i18n.language);
  const { articleId } = useParams<{ articleId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [replyTo, setReplyTo] = useState<{ rootId: string; replyToUserId?: string } | null>(null);
  const [authPrompt, setAuthPrompt] = useState<{ title: string; message: string } | null>(null);

  const articleQuery = useQuery({
    queryKey: ["community-article", articleId],
    queryFn: () => api.getCommunityArticle(articleId!),
    enabled: !!articleId,
  });

  const commentsQuery = useQuery({
    queryKey: ["community-comments", articleId],
    queryFn: () => api.listCommunityComments(articleId!),
    enabled: !!articleId && articleQuery.data?.article.commentsEnabled === true,
  });

  const interactionsQuery = useQuery({
    queryKey: ["community-interactions", articleId],
    queryFn: () => api.getCommunityInteractions([articleId!]),
    enabled: !!user && !!articleId,
  });

  const interaction = articleId ? interactionsQuery.data?.interactions[articleId] : undefined;
  const liked = interaction?.liked ?? false;
  const bookmarked = interaction?.bookmarked ?? false;
  const invalidateArticleState = () => {
    queryClient.invalidateQueries({ queryKey: ["community-article", articleId] });
    queryClient.invalidateQueries({ queryKey: ["community-interactions", articleId] });
  };
  const requireAuth = (title: string, message: string) => {
    setAuthPrompt({ title, message });
  };

  const likeMutation = useMutation({
    mutationFn: () => api.likeCommunityArticle(articleId!),
    onSuccess: invalidateArticleState,
  });
  const unlikeMutation = useMutation({
    mutationFn: () => api.unlikeCommunityArticle(articleId!),
    onSuccess: invalidateArticleState,
  });
  const bookmarkMutation = useMutation({
    mutationFn: () => api.bookmarkCommunityArticle(articleId!),
    onSuccess: invalidateArticleState,
  });
  const unbookmarkMutation = useMutation({
    mutationFn: () => api.unbookmarkCommunityArticle(articleId!),
    onSuccess: invalidateArticleState,
  });
  const featureMutation = useMutation({
    mutationFn: (featured: boolean) => api.setCommunityArticleFeatured(articleId!, featured),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["community-article", articleId] }),
  });
  const hideMutation = useMutation({
    mutationFn: () => api.hideCommunityArticle(articleId!),
    onSuccess: () => navigate("/community"),
  });
  const feedbackStatusMutation = useMutation({
    mutationFn: (feedbackStatus: CommunityFeedbackStatus) =>
      api.updateCommunityFeedbackStatus(articleId!, feedbackStatus),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["community-article", articleId] }),
  });

  const commentMutation = useMutation({
    mutationFn: (input: { body: string; rootId?: string; replyToUserId?: string }) =>
      api.createCommunityComment(articleId!, input),
    onSuccess: () => {
      setCommentBody("");
      setReplyTo(null);
      queryClient.invalidateQueries({ queryKey: ["community-comments", articleId] });
      queryClient.invalidateQueries({ queryKey: ["community-article", articleId] });
    },
  });

  if (articleQuery.isLoading) return <main className="community-page"><div className="community-empty">{t("community.loading")}</div></main>;
  if (articleQuery.isError || !articleQuery.data) return <main className="community-page"><div className="community-empty">{t("community.notFound")}</div></main>;

  const article = articleQuery.data.article;
  const comments = commentsQuery.data?.comments ?? [];
  const isAdmin = Boolean(user?.isCommunityAdmin);
  const commentsEnabled = article.commentsEnabled !== false;
  const primaryActionKey = article.kind === "bug" ? "encountered" : article.kind === "feature_request" ? "vote" : "like";
  const completedActionKey = article.kind === "bug" ? "encounteredDone" : article.kind === "feature_request" ? "voted" : "liked";
  const feedbackStatuses: CommunityFeedbackStatus[] = article.kind === "bug"
    ? ["open", "fixed", "closed"]
    : ["open", "planned", "shipped", "declined"];

  // Group comments: root comments + their replies
  const rootComments = comments.filter((c) => !c.rootId);
  const repliesByRoot = new Map<string, typeof comments>();
  for (const c of comments) {
    if (c.rootId) {
      const arr = repliesByRoot.get(c.rootId) ?? [];
      arr.push(c);
      repliesByRoot.set(c.rootId, arr);
    }
  }

  return (
    <main className="community-page">
      <header className="community-topbar">
        <Link to="/community" className="community-topbar-brand">
          <span>← {t("community.back")}</span>
          <small>{t("community.labels.article")}</small>
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

      <article className="community-content community-article-detail">
        <section aria-label={t("community.detail.infoAria")} className="community-detail-header">
        <div className="community-detail-context">
          <span>{t(`community.kinds.${article.kind}`)}</span>
          {article.isFeatured ? <span className="community-status-badge">{t("community.featured")}</span> : null}
          {article.feedbackStatus ? <span className="community-status-badge">{t(`community.feedbackStatus.${article.feedbackStatus}`)}</span> : null}
        </div>
        <h1 className="community-detail-title">{article.title}</h1>
        <div className="community-article-card-meta">
          <Link to={`/community/author/${article.author.id}`}>{article.author.nickname}</Link>
          {article.author.isOfficial && <span className="community-official-badge">{t("community.official")}</span>}
          {article.author.isMember && <span className="community-member-badge">{t("community.member")}</span>}
          <span>·</span>
          <span>{article.publishedAt ? formatDate(article.publishedAt, locale, { dateStyle: "medium" }) : ""}</span>
        </div>
        {article.tags.length ? <div aria-label={t("community.tags")} className="community-article-tags">
          {article.tags.map((tag) => <span key={tag}>{tag}</span>)}
        </div> : null}
        </section>

        <MarkdownPreview content={article.body} />

        <div className="community-detail-actions">
          {user ? (
            <>
              <button
                className="secondary-button"
                disabled={likeMutation.isPending || unlikeMutation.isPending}
                onClick={() => liked ? unlikeMutation.mutate() : likeMutation.mutate()}
              >{t(`community.actions.${liked ? completedActionKey : primaryActionKey}`)} {formatNumber(article.likeCount, locale)}</button>
              {article.kind === "article" ? (
                <button
                  className="secondary-button"
                  disabled={bookmarkMutation.isPending || unbookmarkMutation.isPending}
                  onClick={() => bookmarked ? unbookmarkMutation.mutate() : bookmarkMutation.mutate()}
                >{t(bookmarked ? "community.actions.bookmarked" : "community.actions.bookmark")}</button>
              ) : null}
            </>
          ) : (
            <>
              <button
                className="secondary-button"
                type="button"
                onClick={() => requireAuth(t("community.auth.likeTitle"), t("community.auth.likeMessage"))}
              >{t(`community.actions.${primaryActionKey}`)} {formatNumber(article.likeCount, locale)}</button>
              {article.kind === "article" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => requireAuth(t("community.auth.bookmarkTitle"), t("community.auth.bookmarkMessage"))}
                >{t("community.actions.bookmark")}</button>
              ) : null}
            </>
          )}
        </div>

        {isAdmin ? (
          <div className="community-admin-actions" aria-label={t("community.detail.adminAria")}>
            <button
              className="secondary-button"
              disabled={featureMutation.isPending}
              onClick={() => featureMutation.mutate(!article.isFeatured)}
              type="button"
            >{t(article.isFeatured ? "community.detail.unfeature" : "community.detail.feature")}</button>
            <button
              className="secondary-button danger"
              disabled={hideMutation.isPending}
              onClick={() => hideMutation.mutate()}
              type="button"
            >{t("community.detail.hide")}</button>
            {article.kind === "bug" || article.kind === "feature_request" ? (
              <select
                aria-label={t("community.detail.statusAria")}
                disabled={feedbackStatusMutation.isPending}
                value={article.feedbackStatus ?? "open"}
                onChange={(event) => feedbackStatusMutation.mutate(event.target.value as CommunityFeedbackStatus)}
              >
                {feedbackStatuses.map((status) => <option key={status} value={status}>{t(`community.feedbackStatus.${status}`)}</option>)}
              </select>
            ) : null}
          </div>
        ) : null}

        {commentsEnabled ? <section className="community-comments">
          <h2 className="community-comments-heading">{t("community.detail.comments", { count: formatNumber(article.commentCount, locale) })}</h2>

          {user ? (
            <form
              className="community-comment-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!commentBody.trim()) return;
                commentMutation.mutate({
                  body: commentBody,
                  rootId: replyTo?.rootId,
                  replyToUserId: replyTo?.replyToUserId,
                });
              }}
            >
              {replyTo && (
                <div className="community-reply-hint">
                  {t("community.detail.replying")} · <button type="button" onClick={() => setReplyTo(null)}>{t("community.detail.cancel")}</button>
                </div>
              )}
              <textarea
                className="community-comment-input"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder={t(replyTo ? "community.detail.replyPlaceholder" : "community.detail.commentPlaceholder")}
                rows={3}
              />
              <button type="submit" className="primary-button" disabled={commentMutation.isPending || !commentBody.trim()}>
                {t(replyTo ? "community.detail.reply" : "community.detail.comment")}
              </button>
            </form>
          ) : (
            <div className="community-comment-login">
              <button
                className="primary-button"
                type="button"
                onClick={() => requireAuth(t("community.auth.commentTitle"), t("community.auth.commentMessage"))}
              >{t("community.detail.comment")}</button>
            </div>
          )}

          <div className="community-comment-list">
            {rootComments.map((comment) => (
              <div key={comment.id} className="community-comment">
                <div className="community-comment-header">
                  <Link to={`/community/author/${comment.author.id}`}>{comment.author.nickname}</Link>
                  {comment.author.isOfficial && <span className="community-official-badge">{t("community.official")}</span>}
                    {comment.author.isMember && <span className="community-member-badge">{t("community.member")}</span>}
                  <span className="community-comment-time">{formatDate(comment.createdAt, locale, { dateStyle: "medium" })}</span>
                </div>
                <p className="community-comment-body">{comment.body}</p>
                <div className="community-comment-actions">
                  {user ? (
                    <button
                      className="community-comment-reply-btn"
                      onClick={() => setReplyTo({ rootId: comment.id })}
                    >{t("community.detail.reply")}</button>
                  ) : (
                    <button
                      className="community-comment-reply-btn"
                      type="button"
                      onClick={() => requireAuth(t("community.auth.replyTitle"), t("community.auth.replyMessage"))}
                    >{t("community.detail.reply")}</button>
                  )}
                </div>

                {/* Flat replies under this root */}
                {(repliesByRoot.get(comment.id) ?? []).map((reply) => (
                  <div key={reply.id} className="community-comment community-comment-reply">
                    <div className="community-comment-header">
                      <Link to={`/community/author/${reply.author.id}`}>{reply.author.nickname}</Link>
                      {reply.replyToUserId && <span className="community-comment-reply-to">{t("community.detail.replyTo")}</span>}
                      {reply.author.isOfficial && <span className="community-official-badge">{t("community.official")}</span>}
                      {reply.author.isMember && <span className="community-member-badge">{t("community.member")}</span>}
                      <span className="community-comment-time">{formatDate(reply.createdAt, locale, { dateStyle: "medium" })}</span>
                    </div>
                    <p className="community-comment-body">{reply.body}</p>
                    {user ? (
                      <button
                        className="community-comment-reply-btn"
                        onClick={() => setReplyTo({ rootId: comment.id, replyToUserId: reply.author.id })}
                      >{t("community.detail.reply")}</button>
                    ) : (
                      <button
                        className="community-comment-reply-btn"
                        type="button"
                        onClick={() => requireAuth(t("community.auth.replyTitle"), t("community.auth.replyMessage"))}
                      >{t("community.detail.reply")}</button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section> : null}
      </article>
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
