import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Menu, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { AiAssistantRail } from "../assistant/AiAssistantRail";
import type { DelegationDrillRequest, DelegationDrillTarget } from "../assistant/delegation-drill";
import { DelegationDrillContext } from "../assistant/delegation-drill";
import type { ChatTraceState } from "../assistant/chat-trace";
import { IconButton } from "../ui/IconButton";
import { SessionManagerDialog } from "../session/SessionManagerDialog";
import { useProjectSessions, useSessionMessages } from "../session/useProjectSessions";
import type { DocumentIndex, Project, User } from "../types";
import { MobileWorkbenchHeader } from "./MobileWorkbenchHeader";
import { AppFrame } from "../shell/AppFrame";
import { SessionRail } from "./SessionRail";
import { UnsavedChangesProvider, useUnsavedChanges } from "./UnsavedChangesGuard";
import { WorkspacePanel } from "./WorkspacePanel";
import { resolveWorkspaceView, type WorkspaceViewId } from "./workspace-view";
import { WORKBENCH_MODULES, getWorkbenchModule, isWorkbenchModuleId } from "./module-config";
import { useViewportMode, type ViewportMode } from "./useViewportMode";

const WORKSPACE_DETAIL_STORAGE_KEY = "novel-vibe:workspace-detail-collapsed";

// Chat-first landing: an unknown preference means the workspace detail stays
// collapsed; only an explicit stored "false" reopens it.
function initialDetailCollapsed() {
  try {
    return window.localStorage.getItem(WORKSPACE_DETAIL_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

interface WorkbenchShellProps {
  projects: Project[];
  user: User;
  onSignedOut: () => void;
}

export interface WorkbenchContext {
  activeDocumentPath: string | null;
  /** Slide-out document list beside the editor (better-sidebar tree). */
  docRailOpen: boolean;
  documents: DocumentIndex[];
  documentsLoading: boolean;
  project: Project;
  refreshDocuments: () => Promise<unknown>;
  setActiveDocumentPath: (path: string | null) => void;
  setDocRailOpen: (open: boolean) => void;
  accessMode: "writable" | "read-only";
  viewportMode: ViewportMode;
}

export function useWorkbench() {
  return useOutletContext<WorkbenchContext>();
}

/** First workspace path segment after the project id: module, "settings", "skills", or null at the project root. */
function pageIdFromPath(pathname: string, projectId: string): string | null {
  const rest = pathname.split(`/projects/${projectId}/`)[1];
  if (!rest) return null;
  return rest.split("/")[0] || null;
}

export function WorkbenchShell({ onSignedOut, projects, user }: WorkbenchShellProps) {
  return (
    <UnsavedChangesProvider>
      <WorkbenchShellContent onSignedOut={onSignedOut} projects={projects} user={user} />
    </UnsavedChangesProvider>
  );
}

function WorkbenchShellContent({ onSignedOut, projects, user }: WorkbenchShellProps) {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const location = useLocation();
  // The workspace page lives in the first path segment after the project id.
  // Deriving it from the path (instead of useParams) also covers the static
  // child routes settings/ and skills/, which declare no :moduleId param and
  // used to be mistaken for "no page matched" by the overview redirect.
  const pageId = pageIdFromPath(location.pathname, projectId ?? "");
  const project = useMemo(
    () => projects.find((item) => item.id === projectId),
    [projectId, projects],
  );
  const documents = useQuery({
    enabled: Boolean(project),
    queryFn: () => api.listDocuments(project!.id),
    queryKey: ["documents", project?.id],
  });
  const isTrash = project?.lifecycle_status === "trash";
  const accessMode = project?.lifecycle_status === "archived" || isTrash ? "read-only" : "writable";
  const viewportMode = useViewportMode();
  const compactWorkbench = viewportMode !== "desktop";
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | null>(null);
  // The module document list starts collapsed (better-sidebar): the rail icon
  // or a module switch opens it; picking a document hands the space back.
  const [docRailOpen, setDocRailOpen] = useState(false);
  // Desktop: false = full session rail, true = 56px icon rail. Compact
  // viewports reuse the same flag for the overlay drawer (starts closed).
  const [contextCollapsed, setContextCollapsed] = useState(() => viewportMode !== "desktop");
  // The conversation is the permanent center column; the workspace pages sit
  // behind a collapsible right column. Compact viewports start collapsed so
  // the chat owns the screen until a page is requested.
  // null = the user has not expressed a preference: deep links onto a concrete
  // page (module, settings, skills…) boot expanded, the chat-first landing
  // boots collapsed. Initial state is computed once, so the overview redirect
  // landing on a module afterwards does not reopen the pane.
  const [detailUserState, setDetailUserState] = useState<boolean | null>(
    () => (pageId != null && pageId !== "overview") ? false : null,
  );
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  // The active workspace tab lives in the URL (?view=review|agent; absent =
  // manuscript), so every tab is deep-linkable and history moves between them.
  const [searchParams, setSearchParams] = useSearchParams();
  const workspaceView = resolveWorkspaceView(searchParams.get("view"));
  const lastTabViewRef = useRef<WorkspaceViewId>("workspace");
  const [drill, setDrill] = useState<DelegationDrillTarget | null>(null);
  const [reviewFocusVersionId, setReviewFocusVersionId] = useState<string | null>(null);
  const liveTraces = useRef<Record<string, ChatTraceState>>({});
  const detailCollapsed = detailUserState
    ?? (compactWorkbench || initialDetailCollapsed());
  const sessionState = useProjectSessions(project?.id ?? "", user.id, accessMode === "writable");
  const messageState = useSessionMessages(sessionState.currentSession?.id ?? null);
  const chatAccessMode = accessMode === "read-only" || sessionState.currentSession?.lifecycleStatus === "archived"
    ? "read-only" : "writable";
  const navigate = useNavigate();
  const { runAfterDiscard } = useUnsavedChanges();

  // Remember the module the writer actually works in per project, so opening
  // the workspace area from the chat-first overview lands straight on a real
  // page instead of the project brief. Static pages (settings, skills) are
  // not workbench modules and are not remembered.
  useEffect(() => {
    if (!project?.id || pageId === "overview" || !isWorkbenchModuleId(pageId ?? undefined)) return;
    try {
      window.localStorage.setItem(`novel-vibe:last-module:${project.id}`, pageId as string);
    } catch {
      // Remembering is best-effort; the default-module fallback still applies.
    }
  }, [pageId, project?.id]);

  function changeWorkspaceView(view: WorkspaceViewId) {
    if (view === workspaceView) return;
    if (view !== "agent") lastTabViewRef.current = view;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (view === "workspace") next.delete("view");
      else next.set("view", view);
      return next;
    });
  }

  function closeDrill() {
    setDrill(null);
    changeWorkspaceView(lastTabViewRef.current);
  }

  const drillContextValue = {
    liveTraces,
    open: (target: DelegationDrillRequest) => {
      setDrill({ ...target, sessionId: sessionState.currentSession?.id ?? null });
      changeWorkspaceView("agent");
      updateDetailCollapsed(false);
    },
  };

  useEffect(() => {
    setActiveDocumentPath(null);
    setSessionManagerOpen(false);
  }, [project?.id]);

  // Desktop permanently shows the session rail; stale closed flags from a
  // previous compact period must not hide it.
  useEffect(() => {
    if (!compactWorkbench) setContextCollapsed(false);
  }, [compactWorkbench]);

  // Every module entry point (rail icon, document-change card, openWorkspaceArea,
  // rail footer pages) expands the pane explicitly in its own click handler;
  // the shell itself never auto-expands, so the overview → module redirect
  // keeps the chat-first collapsed boot.

  async function signOut() {
    try {
      await api.logout();
    } finally {
      onSignedOut();
    }
  }

  function updateContextCollapsed(collapsed: boolean) {
    setContextCollapsed(collapsed);
  }

  function updateDetailCollapsed(collapsed: boolean) {
    if (compactWorkbench && !collapsed) updateContextCollapsed(true);
    setDetailUserState(collapsed);
    try {
      window.localStorage.setItem(WORKSPACE_DETAIL_STORAGE_KEY, String(collapsed));
    } catch {
      // The layout remains usable when browser storage is unavailable.
    }
  }

  function handleContextCollapsedChange(collapsed: boolean) {
    if (compactWorkbench && !collapsed) updateDetailCollapsed(true);
    updateContextCollapsed(collapsed);
  }


  const compactOverlayOpen = compactWorkbench && (!contextCollapsed || !detailCollapsed);
  const mobileNavigationOpen = viewportMode === "mobile" && !contextCollapsed;
  // The phone navigation sheet ships its own Radix overlay and the phone
  // workspace covers the full screen, so only the tablet overlays need the
  // shared scrim.
  const customScrimOpen = viewportMode === "compact" && (!contextCollapsed || !detailCollapsed);

  useEffect(() => {
    if (!compactOverlayOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextCollapsed(true);
      setDetailUserState(true);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [compactOverlayOpen]);

  if (!project) {
    return <Navigate replace to={`/projects/${projects[0].id}/overview`} />;
  }
  const activeProject = project;

  /**
   * The workspace page to land on when the reader opens the area without a
   * specific target: the module they last worked in, else the first module
   * that actually has documents. Never the overview — that is a brief, not
   * the workbench.
   */
  // The overview brief no longer exists as a page: /overview lands in real work.
  // Static child pages (settings, skills) are real pages — keep them.
  const overviewRedirect = pageId === "overview" || pageId == null
    ? <Navigate replace to={`/projects/${projectId}/${preferredWorkspaceModule()}`} />
    : null;

  function preferredWorkspaceModule(): string {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(`novel-vibe:last-module:${activeProject.id}`);
    } catch {
      // Fall through to document-derived preference.
    }
    if (stored && isWorkbenchModuleId(stored) && stored !== "overview") {
      const known = getWorkbenchModule(stored);
      const populated = known.documentTypes.length === 0
        || Boolean(documents.data?.some((doc) => known.documentTypes.includes(doc.doc_type)));
      if (populated) return stored;
    }
    const fallback = WORKBENCH_MODULES.find(
      (module) => module.documentTypes.length > 0
        && documents.data?.some((doc) => module.documentTypes.includes(doc.doc_type)),
    );
    return fallback?.id ?? "chapters";
  }


  /** Toggle entry points: expanding from the overview routes into real work first. */
  function openWorkspaceArea() {
    if (pageId == null || pageId === "overview") {
      runAfterDiscard(() => navigate(`/projects/${activeProject.id}/${preferredWorkspaceModule()}`));
    }
    updateDetailCollapsed(false);
  }

  const context: WorkbenchContext = {
    accessMode,
    activeDocumentPath,
    docRailOpen,
    documents: documents.data ?? [],
    documentsLoading: documents.isLoading,
    project,
    refreshDocuments: documents.refetch,
    setActiveDocumentPath,
    setDocRailOpen,
    viewportMode,
  };

  const sessionRail = (
    <SessionRail
      canCreate={accessMode === "writable"}
      compact={viewportMode !== "mobile" && contextCollapsed}
      creating={sessionState.creating}
      currentSessionId={sessionState.currentSession?.id ?? null}
      hasMore={sessionState.hasNextManagerPage}
      loading={sessionState.sessionsLoading}
      onDelete={sessionState.deleteSession}
      onLoadMore={sessionState.fetchNextManagerPage}
      onNavigate={viewportMode === "mobile" ? () => handleContextCollapsedChange(true) : undefined}
      onFooterNavigate={() => updateDetailCollapsed(false)}
      onOpenManager={() => setSessionManagerOpen(true)}
      onCreate={sessionState.createSession}
      onRename={sessionState.renameSession}
      onSignedOut={() => void signOut()}
      onSelect={async (sessionId) => {
        await sessionState.selectSession(sessionId);
        if (viewportMode !== "mobile") updateDetailCollapsed(true);
      }}
      project={project}
      sessions={sessionState.sessions}
      user={user}
    />
  );

  return (
    <main
      className="workbench"
      data-compact={compactWorkbench || undefined}
      data-context-collapsed={contextCollapsed}
      data-detail-collapsed={detailCollapsed}
      data-motion="workbench-reveal"
      data-overlay-open={compactOverlayOpen || undefined}
      data-viewport={viewportMode}
    >
      {viewportMode === "mobile" ? (
        <MobileWorkbenchHeader
          contextOpen={!contextCollapsed}
          detailOpen={!detailCollapsed}
          moduleLabel={pageId === "settings"
            ? t("workbench.projectSettings")
            : pageId === "skills"
              ? t("workbench.skillManagement")
              : t(getWorkbenchModule(pageId ?? undefined).labelKey)}
          onContextOpenChange={(open) => handleContextCollapsedChange(!open)}
          onDetailOpenChange={(open) => (open ? openWorkspaceArea() : updateDetailCollapsed(false))}
          projectTitle={project.title}
        />
      ) : null}
      {viewportMode === "mobile" ? (
        <Dialog.Root onOpenChange={(open) => handleContextCollapsedChange(!open)} open={mobileNavigationOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="mobile-navigation-overlay" />
            <Dialog.Content className="mobile-navigation-sheet">
              <Dialog.Title className="visually-hidden">{t("workbench.mobile.projectNavigation")}</Dialog.Title>
              {sessionRail}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
      <AppFrame
        center={
          <DelegationDrillContext.Provider value={drillContextValue}>
            <AiAssistantRail
              activeDocumentPath={activeDocumentPath}
              currentSession={sessionState.currentSession}
              hasOlderMessages={messageState.hasOlder}
              headerActions={
                viewportMode !== "mobile" ? (
                <>
                  <IconButton
                    aria-expanded={!contextCollapsed}
                    label={t(contextCollapsed ? "workbench.expandContext" : "workbench.collapseContext")}
                    onClick={() => updateContextCollapsed(!contextCollapsed)}
                  >
                    <Menu size={16} />
                  </IconButton>
                  <IconButton
                    aria-expanded={!detailCollapsed}
                    label={t(detailCollapsed ? "workbench.expandWorkspace" : "workbench.collapseWorkspace")}
                    onClick={() => (detailCollapsed ? openWorkspaceArea() : updateDetailCollapsed(true))}
                  >
                    {detailCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
                  </IconButton>
                </>
                ) : null
              }
              inert={compactOverlayOpen}
              loadingOlderMessages={messageState.loadingOlder}
              messages={messageState.messages}
              onLoadOlderMessages={messageState.fetchOlder}
              onOpenDocumentChange={(versionId) => {
                setReviewFocusVersionId(versionId);
                changeWorkspaceView("review");
                updateDetailCollapsed(false);
              }}
              onOpenContext={() => openWorkspaceArea()}
              presentation={viewportMode === "mobile" ? "fullscreen" : "primary"}
              project={project}
              accessMode={chatAccessMode}
            />
          </DelegationDrillContext.Provider>
        }
        details={
          <section aria-label={t("workbench.creativeArea")} className="workspace-main">
            {accessMode === "read-only" ? <div className="read-only-banner">{t("workbench.readOnly")}</div> : null}
            <WorkspacePanel
              activeModuleId={isWorkbenchModuleId(pageId ?? undefined) ? pageId : null}
              activeView={workspaceView}
              docRailOpen={docRailOpen}
              drill={drill}
              focusVersionId={reviewFocusVersionId}
              messages={messageState.messages}
              onCollapse={() => updateDetailCollapsed(true)}
              onCloseDrill={closeDrill}
              onDocRailToggle={() => setDocRailOpen(!docRailOpen)}
              onModuleSelect={(selected) => {
                runAfterDiscard(() => navigate(`/projects/${projectId}/${selected}`));
                setDocRailOpen(true);
                updateDetailCollapsed(false);
              }}
              onViewChange={(view) => {
                if (view !== "review") setReviewFocusVersionId(null);
                changeWorkspaceView(view);
              }}
              workspace={overviewRedirect ?? <Outlet context={context} />}
            />
          </section>
        }
        detailsSlot="panel"
        sidebarCollapsed={contextCollapsed}
        detailsCollapsed={detailCollapsed}
        onSidebarCollapsedChange={(collapsed) => handleContextCollapsedChange(collapsed)}
        onDetailsCollapsedChange={(collapsed) => (collapsed ? updateDetailCollapsed(true) : openWorkspaceArea())}
        gutters={viewportMode === "desktop"}
        sidebar={sessionRail}
      />
            {customScrimOpen ? (
        <button
          aria-label={t("workbench.closeTemporaryPanel")}
          className="workbench-scrim"
          onClick={() => {
            setContextCollapsed(true);
            setDetailUserState(true);
          }}
          type="button"
        />
      ) : null}
      <SessionManagerDialog
        currentSessionId={sessionState.currentSession?.id ?? null}
        hasMore={Boolean(sessionState.hasNextManagerPage)}
        loading={sessionState.managerLoading}
        onCreate={sessionState.createSession}
        onArchive={sessionState.archiveSession}
        onDelete={sessionState.deleteSession}
        onLoadMore={sessionState.fetchNextManagerPage}
        onOpenChange={setSessionManagerOpen}
        onRename={sessionState.renameSession}
        onRestore={sessionState.restoreSession}
        onSearch={sessionState.setSearch}
        onSelect={sessionState.selectSession}
        open={sessionManagerOpen}
        sessions={sessionState.managerSessions}
        status={sessionState.managerStatus}
        onStatusChange={sessionState.setManagerStatus}
      />
    </main>
  );
}
