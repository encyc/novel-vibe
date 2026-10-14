import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Plus, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import type { ChatSession } from "../types";
import { sessionDisplayTitle } from "./display-title";

interface SessionManagerDialogProps {
  currentSessionId: string | null;
  hasMore: boolean;
  loading: boolean;
  open: boolean;
  sessions: ChatSession[];
  onOpenChange: (open: boolean) => void;
  onSearch: (search: string) => void;
  onSelect: (sessionId: string) => void | Promise<unknown>;
  onCreate: () => void | Promise<unknown>;
  onArchive: (sessionId: string) => void | Promise<unknown>;
  onRename: (sessionId: string, title: string) => void | Promise<unknown>;
  onRestore: (sessionId: string) => void | Promise<unknown>;
  onDelete: (sessionId: string) => void | Promise<unknown>;
  onLoadMore: () => void | Promise<unknown>;
  status: "active" | "archived";
  onStatusChange: (status: "active" | "archived") => void;
}

export function SessionManagerDialog({
  onArchive,
  currentSessionId,
  hasMore,
  loading,
  onCreate,
  onDelete,
  onLoadMore,
  onOpenChange,
  onRename,
  onRestore,
  onSearch,
  onSelect,
  open,
  sessions,
  status,
  onStatusChange,
}: SessionManagerDialogProps) {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ChatSession | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleting, setDeleting] = useState<ChatSession | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => onSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [onSearch, search]);

  async function select(sessionId: string) {
    await onSelect(sessionId);
    onOpenChange(false);
  }

  async function saveName() {
    const title = editTitle.trim();
    if (!editing || !title) return;
    await onRename(editing.id, title);
    setEditing(null);
  }

  async function confirmDelete() {
    if (!deleting || deleting.isProcessing) return;
    await onDelete(deleting.id);
    setDeleting(null);
  }

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="session-dialog-overlay" />
        <Dialog.Content aria-describedby={undefined} className="session-dialog-content" data-motion="dialog-settle">
          <header className="session-dialog-header">
            <div><Dialog.Title>{t("workbench.sessions.title")}</Dialog.Title><span>{t("workbench.sessions.description")}</span></div>
            <Dialog.Close aria-label={t("workbench.sessions.closeManager")} className="session-dialog-close"><X size={17} /></Dialog.Close>
          </header>

          <div aria-label={t("workbench.sessions.status")} className="session-manager-tabs" role="tablist">
            <button aria-selected={status === "active"} onClick={() => onStatusChange("active")} role="tab" type="button">{t("workbench.sessions.active")}</button>
            <button aria-selected={status === "archived"} onClick={() => onStatusChange("archived")} role="tab" type="button">{t("workbench.sessions.archived")}</button>
          </div>

          <div className="session-manager-toolbar">
            <label className="session-search"><Search size={15} /><input aria-label={t("workbench.sessions.search")} onChange={(event) => setSearch(event.target.value)} role="searchbox" value={search} /></label>
            {status === "active" ? <button className="session-create-button" onClick={() => void onCreate()} type="button"><Plus size={15} />{t("workbench.sessions.newSession")}</button> : null}
          </div>

          <div className="session-manager-list">
            {loading ? <p className="session-manager-empty">{t("workbench.sessions.loading")}</p> : null}
            {!loading && sessions.length === 0 ? <p className="session-manager-empty">{t("workbench.sessions.empty")}</p> : null}
            {sessions.map((session) => {
              const displayTitle = sessionDisplayTitle(session, t("workbench.sessions.newSession"));
              return (
              <div className="session-manager-row" data-current={session.id === currentSessionId} key={session.id}>
                <button aria-label={t("workbench.sessions.select", { title: displayTitle })} className="session-manager-select" onClick={() => void select(session.id)} type="button">
                  <strong>{displayTitle}</strong>
                  <span>{t("workbench.sessions.messageCount", {
                    count: session.messageCount,
                    date: formatDate(session.lastMessageAt, locale, { dateStyle: "medium", timeStyle: "short" }),
                  })}</span>
                  {session.isProcessing ? <em><i className="session-processing-dot" />{t("workbench.sessions.processing")}</em> : null}
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger aria-label={t("workbench.sessions.actions", { title: displayTitle })} className="session-manager-menu"><MoreHorizontal size={16} /></DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" className="dropdown-content" sideOffset={4}>
                      <DropdownMenu.Item className="dropdown-item" onSelect={() => { setEditing(session); setEditTitle(session.title); }}>{t("workbench.sessions.rename")}</DropdownMenu.Item>
                      {status === "active"
                        ? <DropdownMenu.Item className="dropdown-item" disabled={session.isProcessing} onSelect={() => void onArchive(session.id)}>{t("workbench.sessions.archive")}</DropdownMenu.Item>
                        : <DropdownMenu.Item className="dropdown-item" disabled={session.isProcessing} onSelect={() => void onRestore(session.id)}>{t("workbench.sessions.restore")}</DropdownMenu.Item>}
                      <DropdownMenu.Item className="dropdown-item danger" disabled={session.isProcessing} onSelect={() => setDeleting(session)}>{t("workbench.sessions.delete")}</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
              );
            })}
          </div>

          {hasMore ? <button className="session-load-more" onClick={() => void onLoadMore()} type="button">{t("workbench.sessions.loadMore")}</button> : null}

          {editing ? (
            <div aria-label={t("workbench.sessions.renameDialog")} className="session-confirm-panel" role="dialog">
              <strong>{t("workbench.sessions.renameDialog")}</strong>
              <input aria-label={t("workbench.sessions.sessionName")} autoFocus onChange={(event) => setEditTitle(event.target.value)} value={editTitle} />
              <div><button onClick={() => setEditing(null)} type="button">{t("workbench.sessions.cancel")}</button><button onClick={() => void saveName()} type="button">{t("workbench.sessions.saveName")}</button></div>
            </div>
          ) : null}

          {deleting ? (
            <div aria-label={t("workbench.sessions.deleteDialog")} className="session-confirm-panel" role="alertdialog">
              <strong>{t("workbench.sessions.deleteTitle", { title: deleting.title })}</strong>
              <p>{t("workbench.sessions.deleteDetail")}</p>
              <div><button onClick={() => setDeleting(null)} type="button">{t("workbench.sessions.cancel")}</button><button className="danger" onClick={() => void confirmDelete()} type="button">{t("workbench.sessions.confirmDelete")}</button></div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
