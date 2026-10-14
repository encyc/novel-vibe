import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { BookOpenText, Send, Save } from "lucide-react";
import { api, ApiError } from "../api/client";
import { appUrl } from "../config/public-origin";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { MarkdownPreview } from "../editor/MarkdownPreview";
import { localizeApiError } from "../i18n/error-message";
import type { CommunityKind, CommunitySection, User } from "../types";

interface ArticleEditorPageProps {
  user: User | null;
  onSignedOut: () => void;
}

export function ArticleEditorPage({ user }: ArticleEditorPageProps) {
  const { t } = useTranslation();
  const { articleId } = useParams<{ articleId: string }>();
  const navigate = useNavigate();
  const isEditing = !!articleId;

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<CommunityKind>("article");
  const [section, setSection] = useState<CommunitySection>("tools");
  const [tagsInput, setTagsInput] = useState("");
  const [body, setBody] = useState("");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // beforeunload guard for unsaved changes
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const confirmDiscard = useCallback((action: () => void) => {
    if (!dirty || window.confirm(t("community.editor.discard"))) {
      action();
    }
  }, [dirty, t]);

  // Load existing article for editing
  const articleQuery = useQuery({
    queryKey: ["community-article", articleId],
    queryFn: () => api.getCommunityArticle(articleId!),
    enabled: isEditing,
  });

  useEffect(() => {
    if (articleQuery.data?.article) {
      const a = articleQuery.data.article;
      setTitle(a.title);
      setKind(a.kind);
      setSection(a.section as CommunitySection);
      setBody(a.body);
      setTagsInput(a.tags.join(", "));
    }
  }, [articleQuery.data]);

  const createMutation = useMutation({
    mutationFn: () => api.createCommunityArticle({
      kind, title, body, section, tags: tagsInput.split(",").map((t) => t.trim()).filter(Boolean),
    }),
    onSuccess: (data) => {
      setError(null); setErrorCode(null);
      setDirty(false);
      navigate(`/community/edit/${data.article.id}`);
    },
    onError: (err) => { setError(localizeApiError(err, "community.editor.genericError")); setErrorCode(err instanceof ApiError ? err.code : null); },
  });

  const updateMutation = useMutation({
    mutationFn: () => api.updateCommunityArticle(articleId!, {
      title, body, section, tags: tagsInput.split(",").map((t) => t.trim()).filter(Boolean),
    }),
    onSuccess: () => { setError(null); setErrorCode(null); setDirty(false); },
    onError: (err) => { setError(localizeApiError(err, "community.editor.genericError")); setErrorCode(err instanceof ApiError ? err.code : null); },
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (isEditing) {
        await api.updateCommunityArticle(articleId!, {
          title, body, section, tags: tagsInput.split(",").map((t) => t.trim()).filter(Boolean),
        });
        await api.publishCommunityArticle(articleId!);
      } else {
        const data = await api.createCommunityArticle({
          kind, title, body, section, tags: tagsInput.split(",").map((t) => t.trim()).filter(Boolean),
        });
        await api.publishCommunityArticle(data.article.id);
      }
    },
    onSuccess: () => {
      setError(null); setErrorCode(null);
      setDirty(false);
      navigate(articleId ? `/community/${articleId}` : "/community");
    },
    onError: (err) => { setError(localizeApiError(err, "community.editor.genericError")); setErrorCode(err instanceof ApiError ? err.code : null); },
  });

  // Redirect anonymous users
  if (!user) {
    return (
      <main className="community-page">
        <div className="community-empty">
          <p>{t("community.editor.signInRequired")}</p>
          <a href={appUrl("/login")} className="primary-button">{t("community.signIn")}</a>
        </div>
      </main>
    );
  }

  const kindOptions: CommunityKind[] = [
    "article", "bug", "feature_request",
    ...(user.isCommunityAdmin ? ["announcement" as const] : []),
  ];

  return (
    <main className="community-page">
      <header className="community-topbar">
        <Link to="/community" className="community-topbar-brand" onClick={(e) => {
          e.preventDefault();
          confirmDiscard(() => navigate("/community"));
        }}>← {t("community.back")}</Link>
        <div className="community-topbar-actions">
          <a href={appUrl("/projects")} className="community-nav-link"><BookOpenText size={16} />{t("community.workspace")}</a>
          <button
            className="secondary-button"
            disabled={updateMutation.isPending || createMutation.isPending}
            onClick={() => {
              isEditing ? updateMutation.mutate() : createMutation.mutate();
            }}
          ><Save size={16} />{t("community.editor.saveDraft")}</button>
          <button
            className="primary-button"
            disabled={publishMutation.isPending || !title.trim() || !body.trim()}
            onClick={() => publishMutation.mutate()}
          ><Send size={16} />{t("community.editor.publish")}</button>
        </div>
      </header>

      <div className="community-editor">
        <div className="community-editor-layout">
        <section aria-label={t("community.editor.bodyAria")} className="community-editor-main">
        <input
          className="community-editor-title"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
          placeholder={t("community.editor.titlePlaceholder")}
          autoFocus
        />
        {error ? (
          <p className="form-error" role="alert">
            {error}
            {errorCode === "NICKNAME_REQUIRED" ? <a href={appUrl("/profile")}>{t("community.editor.nicknameLink")}</a> : null}
          </p>
        ) : null}
        <div aria-label={t("community.editor.viewAria")} className="view-mode-control" role="group">
          <button aria-pressed={view === "edit"} data-active={view === "edit"} onClick={() => setView("edit")}>{t("community.editor.edit")}</button>
          <button aria-pressed={view === "preview"} data-active={view === "preview"} onClick={() => setView("preview")}>{t("community.editor.preview")}</button>
        </div>
        {view === "edit" ? (
          <MarkdownEditor value={body} onChange={(v) => { setBody(v); setDirty(true); }} />
        ) : (
          <MarkdownPreview content={body} />
        )}
        </section>
        <aside aria-label={t("community.editor.settingsAria")} className="community-editor-settings">
          <div><span>{t("community.labels.publication")}</span><h2>{t("community.editor.settings")}</h2><p>{t("community.editor.settingsHelp")}</p></div>
        <div className="community-editor-meta">
          <label>{t("community.editor.contentType")}
          <select
            aria-label={t("community.editor.contentType")}
            disabled={isEditing}
            value={kind}
            onChange={(event) => {
              const nextKind = event.target.value as CommunityKind;
              setKind(nextKind);
              setSection(nextKind === "announcement" ? "announcements" : "tools");
              setDirty(true);
            }}
          >
            {kindOptions.map((option) => <option key={option} value={option}>{t(`community.kindOptions.${option}`)}</option>)}
          </select>
          </label>
          <label>{t("community.editor.tags")}
          <input
            aria-label={t("community.editor.tags")}
            className="community-editor-tags"
            value={tagsInput}
            onChange={(e) => { setTagsInput(e.target.value); setDirty(true); }}
            placeholder={t("community.editor.tagsPlaceholder")}
          />
          </label>
        </div>
        <div className="community-publish-checklist"><span>{t("community.editor.checklist")}</span><p>{t("community.editor.checklistHelp")}</p><small>{t(dirty ? "community.editor.unsaved" : "community.editor.saved")}</small></div>
        </aside>
        </div>
      </div>
    </main>
  );
}
