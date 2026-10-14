import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import {
  BookText,
  Coins,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Puzzle,
  Search,
  Settings,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { communityUrl } from "../config/public-origin";
import { formatDate, formatNumber } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import type { ChatSession, Project, User } from "../types";
import { DisplayScaleSelector } from "../display/DisplayScaleSelector";
import { IconButton } from "../ui/IconButton";
import { ThemeSelector } from "../theme/ThemeSelector";
import { sessionDisplayTitle } from "../session/display-title";
import { useUnsavedChanges } from "./UnsavedChangesGuard";

interface SessionRailProps {
  project: Project;
  user: User;
  sessions: ChatSession[];
  currentSessionId: string | null;
  canCreate?: boolean;
  creating?: boolean;
  loading?: boolean;
  hasMore?: boolean;
  /** 56px icon rail for the auto-collapsed shell below the breakpoint. */
  compact?: boolean;
  onCreate: () => void | Promise<unknown>;
  onSelect: (sessionId: string) => void | Promise<unknown>;
  onRename: (sessionId: string, title: string) => void | Promise<unknown>;
  onDelete: (sessionId: string) => void | Promise<unknown>;
  onLoadMore?: () => void | Promise<unknown>;
  onOpenManager: () => void;
  /** Overlay sheets call this after navigation so the drawer closes. */
  onNavigate?: () => void;
  /** Footer page links (settings, skills) open the workspace pane. */
  onFooterNavigate?: () => void;
  /** Shell-contributed sign-out (BFF logout + state clear). */
  onSignedOut: () => void;
}

function updatedLabel(value: string, locale: "zh-CN" | "en") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDate(date, locale, { month: "numeric", day: "numeric" });
}

/**
 * The permanent left column: sessions are the first-class navigation, topped
 * by home/community shortcuts and closed by account, credits, and preferences.
 */
export function SessionRail({
  canCreate = true,
  compact = false,
  creating = false,
  currentSessionId,
  hasMore = false,
  loading = false,
  onDelete,
  onLoadMore,
  onNavigate,
  onFooterNavigate,
  onOpenManager,
  onCreate,
  onRename,
  onSignedOut,
  onSelect,
  project,
  sessions,
  user,
}: SessionRailProps) {
  const { i18n, t } = useTranslation();
  const navigate = useNavigate();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage);
  const { runAfterDiscard } = useUnsavedChanges();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<ChatSession | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleting, setDeleting] = useState<ChatSession | null>(null);

  // Client-side title filter over the loaded window; deep search and archived
  // sessions stay in the manager dialog.
  const visibleSessions = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) =>
      sessionDisplayTitle(session, "").toLowerCase().includes(needle)
      || session.title.toLowerCase().includes(needle));
  }, [filter, sessions]);

  const credits = useQuery({
    queryKey: ["credits", "summary"],
    queryFn: () => api.getCreditSummary(),
    staleTime: 60_000,
  });

  if (compact) {
    return (
      <aside aria-label={t("workbench.sessions.title")} className="session-rail" data-compact="true">
        <Link className="rail-mini-brand" to="/projects"><img alt="" src="/brand/logo-icon.svg" /></Link>
        <IconButton label={t("workbench.sessions.create")} onClick={() => { void onCreate(); closeSheet(); }}>
          <Plus size={18} />
        </IconButton>
        <IconButton label={t("workbench.sessions.search")} onClick={onOpenManager}>
          <Search size={18} />
        </IconButton>
        <div className="rail-mini-dots">
          {sessions.slice(0, 5).map((session) => (
            <button
              aria-label={t("workbench.sessions.select", { title: sessionDisplayTitle(session, "") })}
              className="rail-mini-dot"
              data-current={session.id === currentSessionId}
              data-processing={session.isProcessing || undefined}
              key={session.id}
              onClick={() => void pick(session.id)}
              type="button"
            />
          ))}
        </div>
        <div className="rail-mini-footer">
          <IconButton label={t("workbench.projectSettings")} onClick={() => go(`/projects/${project.id}/settings`)}>
            <Settings size={16} />
          </IconButton>
          <ThemeSelector />
          <IconButton label={t("workbench.signOut")} onClick={() => runAfterDiscard(() => {
            onNavigate?.();
            onSignedOut();
          })}>
            <LogOut size={16} />
          </IconButton>
        </div>
      </aside>
    );
  }

  function closeSheet() {
    onNavigate?.();
  }

  function go(target: string) {
    runAfterDiscard(() => {
      navigate(target);
      // Footer links are workspace pages — make the pane visible so the
      // navigation lands somewhere the reader can see.
      onFooterNavigate?.();
      closeSheet();
    });
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

  async function pick(sessionId: string) {
    await onSelect(sessionId);
    closeSheet();
  }

  return (
    <aside aria-label={t("workbench.sessions.title")} className="session-rail">
      <div className="rail-brand-row">
        <Link className="sidebar-brand" onClick={(event) => { event.preventDefault(); go("/projects"); }} to="/projects">
          <span className="sidebar-logo"><img alt="" src="/brand/logo-icon.svg" /></span>
          <strong>{t("common.brand")}</strong>
        </Link>
        <a
          aria-label={t("workbench.community")}
          className="rail-community-link"
          href={communityUrl()}
          onClick={(event) => {
            event.preventDefault();
            runAfterDiscard(() => {
              onNavigate?.();
              window.location.assign(communityUrl());
            });
          }}
        >
          <MessageSquare size={15} />
        </a>
      </div>
      <div className="rail-project-chip">
        <BookText size={15} />
        <span>{project.title}</span>
      </div>

      <div className="rail-composer-row">
        <button
          className="session-create-button"
          disabled={!canCreate || creating}
          onClick={() => {
            void onCreate();
            closeSheet();
          }}
          type="button"
        >
          <Plus size={14} />{t("workbench.sessions.newSession")}
        </button>
        <label className="session-search">
          <Search size={13} />
          <input
            aria-label={t("workbench.sessions.search")}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("workbench.rail.searchSessions")}
            value={filter}
          />
        </label>
      </div>

      <nav aria-label={t("workbench.rail.sessionList")} className="rail-session-list">
        {loading && !sessions.length ? (
          <p className="rail-list-note">{t("workbench.sessions.loading")}</p>
        ) : null}
        {!loading && !visibleSessions.length ? (
          <p className="rail-list-note">{filter ? t("workbench.rail.noMatch") : t("workbench.sessions.empty")}</p>
        ) : null}
        {visibleSessions.map((session) => {
          const displayTitle = sessionDisplayTitle(session, t("workbench.sessions.newSession"));
          const isEditing = editing?.id === session.id;
          return (
            <div className="rail-session-row" data-current={session.id === currentSessionId} key={session.id}>
              {isEditing ? (
                <form
                  className="rail-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveName();
                  }}
                >
                  <input
                    aria-label={t("workbench.sessions.sessionName")}
                    autoFocus
                    onBlur={() => void saveName()}
                    onChange={(event) => setEditTitle(event.target.value)}
                    value={editTitle}
                  />
                </form>
              ) : (
                <>
                  <button
                    aria-current={session.id === currentSessionId ? "true" : undefined}
                    aria-label={t("workbench.sessions.select", { title: displayTitle })}
                    className="session-select"
                    onClick={() => void pick(session.id)}
                    type="button"
                  >
                    <span className="session-row-title">{displayTitle}</span>
                    <span className="session-row-meta">
                      {session.isProcessing
                        ? <><i className="session-processing-dot" />{t("workbench.sessions.processing")}</>
                        : updatedLabel(session.lastMessageAt, locale)}
                    </span>
                  </button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger
                      aria-label={t("workbench.sessions.actions", { title: displayTitle })}
                      className="session-row-menu"
                    >
                      <MoreHorizontal size={14} />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="start" className="dropdown-content" sideOffset={4}>
                        <DropdownMenu.Item
                          className="dropdown-item"
                          onSelect={() => {
                            setEditing(session);
                            setEditTitle(session.title);
                          }}
                        >{t("workbench.sessions.rename")}</DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="dropdown-item danger"
                          disabled={session.isProcessing}
                          onSelect={() => setDeleting(session)}
                        >{t("workbench.sessions.delete")}</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </>
              )}
            </div>
          );
        })}
        {hasMore && !filter ? (
          <button className="rail-load-more" onClick={() => void onLoadMore?.()} type="button">
            {t("workbench.sessions.loadMore")}
          </button>
        ) : null}
        <button className="session-view-all" onClick={() => {
          onOpenManager();
          closeSheet();
        }} type="button">
          <Search size={13} />{t("workbench.sessions.viewAll")}
        </button>
      </nav>

      {deleting ? (
        <div aria-label={t("workbench.sessions.deleteDialog")} className="session-confirm-panel rail-confirm-panel" role="alertdialog">
          <strong>{t("workbench.sessions.deleteTitle", { title: deleting.title })}</strong>
          <p>{t("workbench.sessions.deleteDetail")}</p>
          <div>
            <button onClick={() => setDeleting(null)} type="button">{t("workbench.sessions.cancel")}</button>
            <button className="danger" onClick={() => void confirmDelete()} type="button">{t("workbench.sessions.confirmDelete")}</button>
          </div>
        </div>
      ) : null}

      <footer className="rail-footer">
        {credits.data ? (
          <Link className="rail-credit" to="/profile">
            <Coins size={13} />
            <strong>{formatNumber(credits.data.balance, locale)}</strong>
            <span>{t("workbench.rail.creditBalance")}</span>
          </Link>
        ) : null}
        <Link className="rail-profile" onClick={(event) => { event.preventDefault(); go("/profile"); }} to="/profile">
          <strong>{user.email.split("@")[0]}</strong>
          <span>{user.email}</span>
        </Link>
        <div className="rail-footer-actions">
          <IconButton label={t("workbench.projectSettings")} onClick={() => go(`/projects/${project.id}/settings`)}>
            <Settings size={16} />
          </IconButton>
          <IconButton label={t("workbench.skillManagement")} onClick={() => go(`/projects/${project.id}/skills`)}>
            <Puzzle size={16} />
          </IconButton>
          <ThemeSelector />
          <DisplayScaleSelector />
          <IconButton label={t("workbench.signOut")} onClick={() => runAfterDiscard(() => {
            onNavigate?.();
            onSignedOut();
          })}>
            <LogOut size={16} />
          </IconButton>
        </div>
      </footer>
    </aside>
  );
}
