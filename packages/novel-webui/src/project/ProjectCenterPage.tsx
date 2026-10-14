import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Archive, BookOpen, Clock3, Crown, LogOut, MessagesSquare, Plus, Search, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api/client";
import { communityUrl } from "../config/public-origin";
import { localizeApiError } from "../i18n/error-message";
import { formatDate } from "../i18n/format";
import { useInterfaceLocale } from "../i18n/LocaleProvider";
import { useLocalMode } from "../local-mode";
import type { Project, User } from "../types";
import { Spinner } from "../ui/Spinner";

type ProjectStatus = "active" | "archived" | "trash";
type ProjectStartMode = "workspace" | "assistant";

interface ProjectDraft {
  title: string;
  genre: string;
  synopsis: string;
}

const EMPTY_DRAFT: ProjectDraft = { title: "", genre: "", synopsis: "" };

const tabs: Array<{ status: ProjectStatus; labelKey: `projects.tabs.${ProjectStatus}`; icon: typeof BookOpen }> = [
  { status: "active", labelKey: "projects.tabs.active", icon: BookOpen },
  { status: "archived", labelKey: "projects.tabs.archived", icon: Archive },
  { status: "trash", labelKey: "projects.tabs.trash", icon: Trash2 },
];

function activityTime(project: Project): number {
  return Date.parse(project.last_activity_at ?? project.updated_at ?? project.created_at ?? "") || 0;
}

function formatActivity(project: Project, locale: "zh-CN" | "en", fallback: string): string {
  const value = project.last_activity_at ?? project.updated_at ?? project.created_at;
  if (!value) return fallback;
  return formatDate(value, locale, { month: "short", day: "numeric" });
}

interface ProjectCenterPageProps {
  user: User;
  onSignedOut: () => void;
}

export function ProjectCenterPage({ onSignedOut, user }: ProjectCenterPageProps) {
  const { t } = useTranslation();
  const localMode = useLocalMode();
  const { locale } = useInterfaceLocale();
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [creativeLanguage, setCreativeLanguage] = useState<Project["creative_language"]>(locale);
  const [startMode, setStartMode] = useState<ProjectStartMode>("workspace");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectQueries = useQueries({
    queries: tabs.map((tab) => ({
      queryKey: ["projects", { status: tab.status }],
      queryFn: () => api.listProjects(tab.status),
    })),
  });
  const projects = projectQueries[tabs.findIndex((tab) => tab.status === status)];
  const createProject = useMutation({
    mutationFn: (input: {
      title: string;
      genre?: string;
      synopsis?: string;
      creative_language: "zh-CN" | "en";
    }) => api.createProject(input),
    onSuccess: (project) => {
      queryClient.setQueryData<Project[]>(["projects", { status: "active" }], (current = []) => [project, ...current]);
      queryClient.invalidateQueries({ queryKey: ["projects"], refetchType: "inactive" });
      if (startMode === "assistant") {
        window.localStorage.setItem("novel-vibe:assistant-collapsed", "false");
      }
      navigate(`/projects/${project.id}/overview`);
    },
  });

  const visibleProjects = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return [...(projects.data ?? [])]
      .sort((left, right) => activityTime(right) - activityTime(left))
      .filter((project) => !term || [project.title, project.genre, project.synopsis]
        .some((value) => value?.toLocaleLowerCase().includes(term)));
  }, [projects.data, search]);

  function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    if (createStep === 1) {
      setCreateStep(2);
      return;
    }
    const genre = draft.genre.trim();
    const synopsis = draft.synopsis.trim();
    createProject.mutate({
      title,
      genre: genre || undefined,
      synopsis: synopsis || undefined,
      creative_language: creativeLanguage,
    });
  }

  function openCreateProject() {
    setDraft(EMPTY_DRAFT);
    setCreateStep(1);
    setStartMode("workspace");
    setCreativeLanguage(locale);
    setCreating(true);
  }

  async function signOut() {
    await api.logout();
    onSignedOut();
  }

  return (
    <main className="project-center">
      <header className="project-center-header">
        <Link className="project-center-brand" to="/projects">
          <span><img alt="" src="/brand/logo-icon.svg" /></span>
          <strong>{t("common.brand")}</strong>
        </Link>
        <div className="project-center-account">
          {!localMode && user.isCommunityAdmin ? <Link className="project-center-community-link" to="/admin/referrals">{t("referral.admin.nav")}</Link> : null}
          {/* Community, membership and referrals live on the hosted service; a local install hides them rather than offering dead entries. */}
          {localMode ? null : <a className="project-center-community-link" href={communityUrl()}><MessagesSquare size={15} />{t("projects.community")}</a>}
          {localMode ? null : <Link className="project-center-community-link" to="/profile/membership"><Crown size={15} />{t("projects.membership")}</Link>}
          <Link className="project-center-profile-link" to="/profile">{user.email}</Link>
          <button aria-label={t("projects.signOut")} className="icon-button" onClick={signOut} type="button"><LogOut size={17} /></button>
        </div>
      </header>

      <section aria-label={t("projects.collection")} className="project-center-content">
        <div className="project-center-titlebar">
          <div>
            <span className="project-center-kicker">{t("projects.kicker")}</span>
            <h1>{t("projects.centerTitle")}</h1>
            <p>{t("projects.centerDescription")}</p>
          </div>
          <button className="primary-button" onClick={openCreateProject} type="button"><Plus size={16} />{t("projects.newProject")}</button>
        </div>

        <div className="project-center-toolbar">
          <div aria-label={t("projects.status")} className="project-tabs" role="tablist">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  aria-label={`${t(tab.labelKey)} ${projectQueries[tabs.indexOf(tab)].data?.length ?? 0}`}
                  aria-selected={status === tab.status}
                  className={status === tab.status ? "active" : ""}
                  key={tab.status}
                  onClick={() => { setStatus(tab.status); setSearch(""); }}
                  role="tab"
                  type="button"
                ><Icon size={14} /><span>{t(tab.labelKey)}</span><strong>{projectQueries[tabs.indexOf(tab)].data?.length ?? 0}</strong></button>
              );
            })}
          </div>
          <label className="project-search">
            <Search aria-hidden="true" size={15} />
            <span className="visually-hidden">{t("projects.search")}</span>
            <input aria-label={t("projects.search")} onChange={(event) => setSearch(event.target.value)} placeholder={t("projects.searchPlaceholder")} type="search" value={search} />
          </label>
        </div>

        {projects.isLoading ? <div className="project-center-state"><Spinner label={t("projects.loading")} /></div> : null}
        {projects.isError ? (
          <div className="project-center-state" role="alert"><p>{t("projects.loadFailed")}</p><button className="secondary-button" onClick={() => projects.refetch()} type="button">{t("common.retry")}</button></div>
        ) : null}
        {!projects.isLoading && !projects.isError && visibleProjects.length === 0 ? (
          <div className="project-center-empty">
            <span><BookOpen size={24} /></span>
            <h2>{search ? t("projects.noMatches") : t(`projects.empty.${status}.title`)}</h2>
            <p>{search ? t("projects.tryAnotherSearch") : t(`projects.empty.${status}.detail`)}</p>
            {status === "active" && !search ? <button className="secondary-button" onClick={openCreateProject} type="button">{t("projects.createFirst")}</button> : null}
          </div>
        ) : null}
        {visibleProjects.length ? (
          <div aria-label={t("projects.directory")} className="project-grid" role="list">
            {visibleProjects.map((project, index) => (
              <div key={project.id} role="listitem">
              <article className="project-card" style={{ "--project-index": index } as React.CSSProperties}>
                <Link aria-label={t("projects.openProjectAria", { title: project.title })} className="project-card-link" to={`/projects/${project.id}/overview`}>
                <span className="project-card-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="project-card-mark"><span>{project.title.slice(0, 1)}</span></div>
                <div className="project-card-copy">
                  <div><span>{project.genre || t("projects.uncategorized")}</span><span><Clock3 size={12} />{formatActivity(project, locale, t("projects.noActivity"))}</span></div>
                  <h2>{project.title}</h2>
                  <p>{project.synopsis || t("projects.noSynopsis")}</p>
                </div>
                <span className="project-card-open">{t("projects.openProject")} <span aria-hidden="true">→</span></span>
                </Link>
              </article>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {creating ? (
        <div className="project-create-overlay" role="presentation">
          <form aria-label={t("projects.createForm")} className="project-create-panel" onSubmit={submitProject}>
            {createStep === 1 ? <>
            <div><span>{t("projects.firstStepEyebrow")}</span><h2>{t("projects.firstStepTitle")}</h2><p>{t("projects.firstStepDetail")}</p></div>
            <label>{t("projects.title")}<input autoFocus name="title" onChange={(event) => setDraft({ ...draft, title: event.target.value })} required value={draft.title} /></label>
            <label>{t("projects.genre")}<input name="genre" onChange={(event) => setDraft({ ...draft, genre: event.target.value })} placeholder={t("projects.genrePlaceholder")} value={draft.genre} /></label>
            <label>{t("projects.synopsis")}<textarea name="synopsis" onChange={(event) => setDraft({ ...draft, synopsis: event.target.value })} placeholder={t("projects.synopsisPlaceholder")} rows={4} value={draft.synopsis} /></label>
            <label>{t("projects.creativeLanguage")}<select aria-label={t("projects.creativeLanguage")} name="creative_language" onChange={(event) => setCreativeLanguage(event.target.value as Project["creative_language"])} value={creativeLanguage}><option value="zh-CN">{t("common.chinese")}</option><option value="en">{t("common.english")}</option></select><small>{t("projects.creativeLanguageHelp")}</small></label>
            </> : <>
            <div><span>{t("projects.secondStepEyebrow")}</span><h2>{t("projects.secondStepTitle")}</h2><p>{t("projects.secondStepDetail")}</p></div>
            <div className="project-start-options">
              <label><input aria-label={t("projects.startWorkspace")} checked={startMode === "workspace"} name="startMode" onChange={() => setStartMode("workspace")} type="radio" /><span><strong>{t("projects.startWorkspace")}</strong><small>{t("projects.startWorkspaceHelp")}</small></span></label>
              <label><input aria-label={t("projects.startAssistant")} checked={startMode === "assistant"} name="startMode" onChange={() => setStartMode("assistant")} type="radio" /><span><strong>{t("projects.startAssistant")}</strong><small>{t("projects.startAssistantHelp")}</small></span></label>
            </div>
            </>}
            {createProject.isError ? (
              <p className="form-error" role="alert">
                {createProject.error instanceof ApiError
                  && !localMode
                  && (createProject.error.code === "PROJECT_LIMIT_REACHED"
                    || (createProject.error.code === null && createProject.error.status === 403))
                  ? <>{t("projects.membershipLimit")}<Link to="/profile/membership">{t("projects.openMembership")}</Link>{t("projects.membershipUnlock")}</>
                  : localizeApiError(createProject.error, "projects.createFailed")}
              </p>
            ) : null}
            <footer>
              {createStep === 2 ? <button className="secondary-button" onClick={() => setCreateStep(1)} type="button">{t("projects.previous")}</button> : null}
              <button className="secondary-button" onClick={() => setCreating(false)} type="button">{t("common.cancel")}</button>
              <button className="primary-button" disabled={createProject.isPending} type="submit">{createProject.isPending ? <Spinner label={t("projects.creating")} /> : null}{t(createStep === 1 ? "projects.next" : "projects.create")}</button>
            </footer>
          </form>
        </div>
      ) : null}
    </main>
  );
}
