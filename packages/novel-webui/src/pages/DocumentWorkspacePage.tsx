import * as Dialog from "@radix-ui/react-dialog";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { X , Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Link, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import { DocumentConflictDialog } from "../editor/DocumentConflictDialog";
import { DocumentDiffViewer } from "../editor/DocumentDiffViewer";
import { DocumentVersionHistory } from "../editor/DocumentVersionHistory";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { MarkdownPreview } from "../editor/MarkdownPreview";
import { useDocumentVersionDiff } from "../editor/useDocumentVersionDiff";
import { localizeApiError } from "../i18n/error-message";
import type { DocumentConflict, DocumentIndex } from "../types";
import { IconButton } from "../ui/IconButton";
import { Spinner } from "../ui/Spinner";
import { useUnsavedChanges } from "../workbench/UnsavedChangesGuard";
import { WorkspaceColophon } from "../workbench/WorkspaceColophon";
import { useWorkbench } from "../workbench/WorkbenchShell";
import { getWorkbenchModule, isWorkbenchModuleId, type WorkbenchModuleId } from "../workbench/module-config";
import { DocumentToolbar, type DocumentExportFormat, type SaveState, type ViewMode } from "./DocumentToolbar";

function continuityWarnings(documents: DocumentIndex[], t: TFunction): string[] {
  const latestChapterDocument = documents
    .filter((doc) => doc.doc_type === "chapter-text" && doc.status === "confirmed" && typeof doc.chapter_num === "number")
    .sort((a, b) => Number(b.chapter_num) - Number(a.chapter_num))[0];
  const latestConfirmedChapter = Number(latestChapterDocument?.chapter_num ?? 0);
  if (!latestConfirmedChapter) return [];

  const warnings: string[] = [];
  const summary = documents
    .filter((doc) => doc.doc_type === "story-summary")
    .sort((a, b) => Number(b.meta?.latest_chapter ?? 0) - Number(a.meta?.latest_chapter ?? 0))[0];
  if (!summary) {
    warnings.push(t("workbench.document.continuity.summaryMissing"));
  } else if (Number(summary.meta?.latest_chapter ?? 0) < latestConfirmedChapter) {
    warnings.push(t("workbench.document.continuity.summaryBehind", { chapter: latestConfirmedChapter }));
  }

  const referencedCharacters = [...new Set(
    Array.isArray(latestChapterDocument?.meta?.characters_present)
      ? latestChapterDocument.meta.characters_present.filter((value): value is string => typeof value === "string")
      : [],
  )];
  const states = documents.filter((doc) => doc.doc_type === "character-state");
  const stateFor = (slug: string) => states.find((doc) =>
    doc.meta?.character === slug || doc.doc_path === `characters/${slug}-state.md`);
  const missingStates = referencedCharacters.filter((slug) => !stateFor(slug));
  if (missingStates.length) {
    warnings.push(t("workbench.document.continuity.characterStatesMissing", { count: missingStates.length }));
  }
  const staleStates = referencedCharacters
    .map(stateFor)
    .filter((doc): doc is DocumentIndex => Boolean(doc))
    .filter((doc) => Number(doc.meta?.latest_chapter ?? 0) < latestConfirmedChapter);
  if (staleStates.length) {
    warnings.push(t("workbench.document.continuity.characterStatesBehind", {
      chapter: latestConfirmedChapter,
      count: staleStates.length,
    }));
  }

  const overdueForeshadows = documents.filter((doc) =>
    doc.doc_type === "foreshadow"
    && doc.status !== "resolved"
    && typeof doc.meta?.planned_resolve === "number"
    && (doc.meta.planned_resolve as number) < latestConfirmedChapter,
  );
  if (overdueForeshadows.length) {
    warnings.push(t("workbench.document.continuity.foreshadowsOverdue", { count: overdueForeshadows.length }));
  }
  return warnings;
}

const moduleEditorial: Record<Exclude<WorkbenchModuleId, "overview">, { eyebrow: string }> = {
  world: { eyebrow: "WORLD BUILDING · 01" },
  characters: { eyebrow: "CHARACTER ARCHIVE · 02" },
  outline: { eyebrow: "STORY OUTLINE · 03" },
  scripts: { eyebrow: "DIRECTOR SCRIPTS · 04" },
  chapters: { eyebrow: "CHAPTER MANUSCRIPTS · 05" },
  continuity: { eyebrow: "CONTINUITY ARCHIVE · 07" },
  lingqi: { eyebrow: "LINGQI GUIDE · 06" },
};

function getConflict(error: unknown): DocumentConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const legacy = error.data as Partial<DocumentConflict> | null;
  const details = error.details as Partial<DocumentConflict> | null;
  const conflict = error.code === "DOCUMENT_CONFLICT" ? (details ?? legacy) : legacy;
  return error.code === "DOCUMENT_CONFLICT"
    && typeof conflict?.content === "string"
    && typeof conflict.hash === "string"
    && typeof conflict.path === "string"
    ? { ...conflict, error: "DOCUMENT_CONFLICT", code: "DOCUMENT_CONFLICT" } as DocumentConflict
    : null;
}

export function DocumentWorkspacePage() {
  const { t } = useTranslation();
  const { moduleId } = useParams();
  const module = getWorkbenchModule(moduleId);
  const {
    documents,
    documentsLoading,
    project,
    refreshDocuments,
    setActiveDocumentPath,
    accessMode,
    viewportMode,
  } = useWorkbench();
  const { docRailOpen, setDocRailOpen } = useWorkbench();
  const { runAfterDiscard, setDirty } = useUnsavedChanges();
  const [searchParams, setSearchParams] = useSearchParams();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [baseHash, setBaseHash] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DocumentConflict | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [docFilter, setDocFilter] = useState("");
  const [exporting, setExporting] = useState(false);
  const queryClient = useQueryClient();

  const moduleDocuments = useMemo(
    () => documents.filter((doc) => module.documentTypes.includes(doc.doc_type)),
    [documents, module.documentTypes],
  );
  const visibleDocuments = useMemo(() => {
    const needle = docFilter.trim().toLowerCase();
    if (!needle) return moduleDocuments;
    return moduleDocuments.filter((doc) =>
      (doc.name ?? "").toLowerCase().includes(needle) || doc.doc_path.toLowerCase().includes(needle));
  }, [docFilter, moduleDocuments]);
  const requestedPath = searchParams.get("document");
  const versionId = searchParams.get("version");
  const selectedDocument = visibleDocuments.find((doc) => doc.doc_path === requestedPath)
    ?? visibleDocuments[0]
    ?? null;
  const continuityIssues = module.id === "continuity" ? continuityWarnings(documents, t) : [];
  const dirty = content !== savedContent;

  useEffect(() => {
    setActiveDocumentPath(selectedDocument?.doc_path ?? null);
    return () => setActiveDocumentPath(null);
  }, [selectedDocument?.doc_path, setActiveDocumentPath]);

  useEffect(() => {
    if (!selectedDocument || requestedPath === selectedDocument.doc_path) return;
    const next = new URLSearchParams(searchParams);
    next.set("document", selectedDocument.doc_path);
    setSearchParams(next, { replace: true });
  }, [requestedPath, searchParams, selectedDocument, setSearchParams]);

  const source = useQuery({
    enabled: Boolean(selectedDocument),
    queryFn: () => api.readDocument(project.id, selectedDocument!.doc_path),
    queryKey: ["document-source", project.id, selectedDocument?.doc_path],
  });

  const versions = useInfiniteQuery({
    queryKey: ["document-versions", project.id, selectedDocument?.doc_path],
    queryFn: ({ pageParam }) => api.listDocumentVersions(project.id, selectedDocument!.doc_path, pageParam || null, 20),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(selectedDocument),
  });
  const versionItems = useMemo(() => versions.data?.pages.flatMap((page) => page.items) ?? [], [versions.data]);
  const {
    version: selectedVersionData,
    diffPages,
    diffFailed,
    diffLoading,
    diffHasMore,
    loadMoreDiff,
  } = useDocumentVersionDiff(versionId);

  useEffect(() => {
    if (!versionId || !selectedVersionData || !selectedDocument || selectedVersionData.path === selectedDocument.doc_path) return;
    const next = new URLSearchParams(searchParams);
    next.delete("version");
    setSearchParams(next, { replace: true });
  }, [searchParams, selectedDocument?.doc_path, selectedVersionData, setSearchParams, versionId]);

  const membership = useQuery({
    queryFn: () => api.getMembershipStatus(),
    queryKey: ["membership", "status"],
  });
  const exportAllowed = membership.data?.active === true && membership.data?.features.includes("export");

  useEffect(() => {
    setContent("");
    setSavedContent("");
    setBaseHash("");
    setActionError(null);
    setConflict(null);
    setViewMode("preview");
  }, [selectedDocument?.doc_path]);

  useEffect(() => {
    if (!source.data) return;
    setContent(source.data.content);
    setSavedContent(source.data.content);
    setBaseHash(source.data.hash);
    setActionError(null);
  }, [source.data, selectedDocument?.doc_path]);

  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);

  const saveDocument = useMutation({
    mutationFn: (draft: { content: string; baseHash: string }) => api.saveDocument(
      project.id,
      selectedDocument!.doc_path,
      draft.content,
      draft.baseHash,
    ),
    onError: (error) => {
      const nextConflict = getConflict(error);
      if (nextConflict) {
        setConflict(nextConflict);
        setActionError(null);
      } else {
        setActionError(localizeApiError(error, "workbench.document.saveFailed"));
      }
    },
    onSuccess: async (result, draft) => {
      setSavedContent(draft.content);
      setBaseHash(result.hash);
      setConflict(null);
      setActionError(null);
      await refreshDocuments();
      await queryClient.invalidateQueries({ queryKey: ["document-versions", project.id, selectedDocument?.doc_path] });
    },
  });

  const performSave = useCallback(() => {
    if (accessMode === "read-only" || !selectedDocument || !baseHash || !dirty || saveDocument.isPending) return;
    setActionError(null);
    setConflict(null);
    saveDocument.mutate({ content, baseHash });
  }, [accessMode, baseHash, content, dirty, saveDocument, selectedDocument]);

  const handleExport = useCallback(async (format: DocumentExportFormat) => {
    if (!selectedDocument || exporting) return;
    setExporting(true);
    try {
      await api.exportDocument(project.id, selectedDocument.doc_path, format);
    } catch (err) {
      setActionError(localizeApiError(err, "workbench.document.exportFailed"));
    } finally {
      setExporting(false);
    }
  }, [exporting, project.id, selectedDocument]);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        performSave();
      }
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [performSave]);

  const deleteDocument = useMutation({
    mutationFn: () => api.deleteDocument(project.id, selectedDocument!.doc_path),
    onError: (error) => setActionError(localizeApiError(error, "workbench.document.deleteFailed")),
    onSuccess: async () => {
      setDeleteOpen(false);
      setContent("");
      setSavedContent("");
      setBaseHash("");
      const next = new URLSearchParams(searchParams);
      next.delete("document");
      setSearchParams(next, { replace: true });
      await queryClient.invalidateQueries({ queryKey: ["documents", project.id] });
    },
  });

  const saveState: SaveState = source.isLoading
    ? "loading"
    : saveDocument.isPending
      ? "saving"
      : conflict
        ? "conflict"
        : actionError
          ? "failed"
          : dirty
            ? "unsaved"
            : "saved";

  function reloadRemote() {
    if (!conflict) return;
    setContent(conflict.content);
    setSavedContent(conflict.content);
    setBaseHash(conflict.hash);
    setConflict(null);
    setActionError(null);
  }

  function selectVersion(nextVersionId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("version", nextVersionId);
    setSearchParams(next);
  }

  function closeVersion() {
    const next = new URLSearchParams(searchParams);
    next.delete("version");
    setSearchParams(next);
  }

  if (!isWorkbenchModuleId(moduleId) || moduleId === "overview") {
    return <Navigate replace to="../overview" />;
  }

  const saveLabel: Record<SaveState, string> = {
    loading: t("workbench.document.saveState.loading"),
    saved: t("workbench.document.saveState.saved"),
    unsaved: t("workbench.document.saveState.unsaved"),
    saving: t("workbench.document.saveState.saving"),
    failed: t("workbench.document.saveState.failed"),
    conflict: t("workbench.document.saveState.conflict"),
  };
  const showVersionHistory = Boolean(selectedDocument && (versionItems.length > 0 || versionId));

  return (
    <div className="document-workspace">
      <WorkspaceColophon eyebrow={moduleEditorial[moduleId].eyebrow} title={t(module.labelKey)} detail={selectedDocument?.doc_path ?? t("workbench.document.noneSelected")}>
        <DocumentToolbar
          canDelete={accessMode !== "read-only" && Boolean(selectedDocument) && !deleteDocument.isPending}
          canExport={accessMode !== "read-only" && Boolean(selectedDocument) && exportAllowed === true && !exporting}
          canSave={accessMode !== "read-only" && Boolean(selectedDocument) && !saveDocument.isPending && dirty}
          exportAllowed={exportAllowed === true}
          exporting={exporting}
          loading={documentsLoading || source.isLoading}
          mobile={viewportMode === "mobile"}
          onDelete={() => runAfterDiscard(() => setDeleteOpen(true))}
          onExport={(format) => void handleExport(format)}
          onRefresh={() => void refreshDocuments()}
          onSave={performSave}
          onViewModeChange={setViewMode}
          saveLabel={saveLabel[saveState]}
          saveState={saveState}
          viewMode={viewMode}
        />
      </WorkspaceColophon>

      {module.id === "continuity" ? (
        <section aria-label={t("workbench.document.continuity.region")} className="workspace-status-panel">
          <div>
            <span className="page-eyebrow">CONTINUITY CHECK</span>
            <h2>{t("workbench.document.continuity.title")}</h2>
          </div>
          {continuityIssues.length ? (
            <ul>
              {continuityIssues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          ) : <p>{t("workbench.document.continuity.healthy")}</p>}
        </section>
      ) : null}

      <div className={`document-workspace-body${showVersionHistory ? " has-version-history" : ""}${moduleDocuments.length > 1 && docRailOpen ? " has-document-rail" : ""}`}>
        {moduleDocuments.length > 1 && docRailOpen ? (
          <nav aria-label={t("workbench.manuscriptDirectory", { module: t(module.labelKey) })} className="workspace-document-rail">
            <div className="workspace-document-rail-head">
              <strong>{t(module.labelKey)}</strong>
              <button
                aria-label={t("workbench.closeDocumentRail")}
                onClick={() => setDocRailOpen(false)}
                type="button"
              >
                <X aria-hidden size={13} />
              </button>
            </div>
            <label className="workspace-document-filter">
              <Search aria-hidden size={13} />
              <input
                aria-label={t("workbench.filterDocuments")}
                onChange={(event) => setDocFilter(event.target.value)}
                placeholder={t("workbench.filterDocuments")}
                value={docFilter}
              />
            </label>
            <div className="workspace-document-list">
              {moduleDocuments.map((doc) => (
                <button
                  aria-current={doc.doc_path === selectedDocument?.doc_path ? "page" : undefined}
                  className={doc.doc_path === selectedDocument?.doc_path ? "active" : ""}
                  key={doc.doc_path}
                  onClick={() => {
                    runAfterDiscard(() => {
                      const next = new URLSearchParams(searchParams);
                      next.set("document", doc.doc_path);
                      next.delete("version");
                      setSearchParams(next);
                    });
                    setDocRailOpen(false);
                  }}
                  type="button"
                >
                  <span>{doc.name || doc.doc_path.split("/").pop()}</span>
                  <small>{doc.doc_path}</small>
                </button>
              ))}
            </div>
          </nav>
        ) : null}
        {showVersionHistory ? (
          <DocumentVersionHistory
            hasMore={Boolean(versions.hasNextPage)}
            loading={versions.isFetchingNextPage}
            onLoadMore={() => void versions.fetchNextPage()}
            onSelect={selectVersion}
            selectedVersionId={versionId}
            versions={versionItems}
          />
        ) : null}
        <section
          aria-label={t("workbench.document.manuscript")}
          className="source-editor"
          data-motion="paper-settle"
          key={selectedDocument?.doc_path ?? "empty-manuscript"}
        >
          {versionId && selectedVersionData ? (
            <DocumentDiffViewer
              error={diffFailed ? (selectedVersionData.diffStatus === "unavailable" ? undefined : t("workbench.document.versions.diffFailed")) : undefined}
              hasMore={diffHasMore}
              loading={diffLoading}
              onClose={closeVersion}
              onLoadMore={loadMoreDiff}
              pages={diffPages}
              version={selectedVersionData}
            />
          ) : versionId && diffLoading ? (
            <div className="workspace-empty"><Spinner label={t("workbench.document.versions.loading")} /></div>
          ) : versionId && !selectedVersionData && !source.isError ? (
            <div className="workspace-error" role="alert"><p>{t("workbench.document.versions.diffFailed")}</p><button onClick={closeVersion} type="button">{t("workbench.document.versions.close")}</button></div>
          ) : source.isError ? (
            <div className="workspace-error" role="alert">
              <p>{localizeApiError(source.error, "workbench.document.readFailed")}</p>
              <button className="secondary-button" onClick={() => source.refetch()} type="button">{t("workbench.document.retry")}</button>
            </div>
          ) : selectedDocument && source.isLoading ? (
            <div className="workspace-empty"><Spinner label={t("workbench.document.reading")} /></div>
          ) : selectedDocument ? (
            viewMode === "edit"
              ? <MarkdownEditor onChange={setContent} value={content} />
              : <MarkdownPreview content={content} />
          ) : (
            <div className="workspace-empty">{t("workbench.document.chooseDocument")}</div>
          )}
          {actionError ? <p className="form-error workspace-action-error" role="alert">{actionError}</p> : null}
        </section>
      </div>

      <DocumentConflictDialog
        conflict={conflict}
        localContent={content}
        onKeepLocal={() => setConflict(null)}
        onReloadRemote={reloadRemote}
      />

      <Dialog.Root onOpenChange={setDeleteOpen} open={deleteOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" data-motion="dialog-settle">
            <div className="dialog-heading">
              <Dialog.Title>{t("workbench.document.deleteDialog.title")}</Dialog.Title>
              <Dialog.Close asChild><IconButton label={t("workbench.document.deleteDialog.close")}><X size={16} /></IconButton></Dialog.Close>
            </div>
            <Dialog.Description>
              {t("workbench.document.deleteDialog.description", { name: selectedDocument?.name || selectedDocument?.doc_path })}
            </Dialog.Description>
            <div className="dialog-actions">
              <Dialog.Close className="secondary-button">{t("workbench.document.deleteDialog.cancel")}</Dialog.Close>
              <button
                className="danger-button"
                disabled={deleteDocument.isPending}
                onClick={() => deleteDocument.mutate()}
                type="button"
              >{t("workbench.document.deleteDialog.confirm")}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
