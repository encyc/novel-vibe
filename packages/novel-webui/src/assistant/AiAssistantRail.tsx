import { Bot, FileText } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { mergeByokModels } from "../api/settings";
import type { AiModel, ChatSession, Project, SessionMessage } from "../types";
import { ChatPanel } from "./ChatPanel";
import { ModelSelector, resolveSelection, usePersistedModelSelection } from "./ModelSelector";

interface AiAssistantRailProps {
  activeDocumentPath: string | null;
  project: Project | null;
  currentSession: ChatSession | null;
  messages: SessionMessage[];
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => void | Promise<unknown>;
  /** Opens the review page on a document version produced by the conversation. */
  onOpenDocumentChange?: (versionId: string) => void;
  /** Reveals the workspace pane showing the active document context. */
  onOpenContext?: () => void;
  accessMode?: "writable" | "read-only";
  /** "primary" — permanent center column on wide viewports; "fullscreen" — base surface on phones. */
  presentation?: "primary" | "fullscreen";
  /** Effective Inert state: true keeps the keyboard/touch focus out while shell overlays are open. */
  inert?: boolean;
  /** Shell-contributed controls appended after the model selector. */
  headerActions?: ReactNode;
}

export function AiAssistantRail({
  activeDocumentPath,
  currentSession,
  hasOlderMessages,
  loadingOlderMessages,
  messages,
  onLoadOlderMessages,
  onOpenDocumentChange,
  onOpenContext,
  project,
  accessMode = "writable",
  presentation = "primary",
  inert = false,
  headerActions,
}: AiAssistantRailProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelSelectionId, setModelSelectionId] = usePersistedModelSelection();

  useEffect(() => {
    let cancelled = false;
    // Premium (member-only) models are hidden from non-members; the server
    // still hard-gates them at chat time, this is display filtering only.
    // BYOK models appear only for members holding the byok entitlement AND a
    // saved key for that provider.
    Promise.all([
      api.listModels(),
      api.getMembershipStatus().catch(() => null),
      api.getMembershipEntitlements().catch(() => null),
      api.getByokConfig().catch(() => null),
      api.listLlmKeys().catch(() => null),
    ])
      .then(([all, status, entitlements, byok, keys]) => {
        if (cancelled) return;
        const hasPremium = status?.active === true && status.features.includes("premium_models");
        const prefixes = entitlements?.premiumModels ?? [];
        const visible = hasPremium
          ? all
          : all.filter((m) => !prefixes.some((prefix) => m.model.startsWith(prefix)));
        const hasByok = status?.active === true && status.features.includes("byok");
        setModels(mergeByokModels(visible, byok ?? null, keys?.keys ?? null, hasByok));
      })
      .catch(() => { /* leave empty — selector falls back to the localized project default */ });
    return () => { cancelled = true; };
  }, []);

  const modelSelection = resolveSelection(models, modelSelectionId);
  const thinking = busy || Boolean(currentSession?.isProcessing);

  return (
    <aside
      aria-label={t("assistant.title")}
      className="ai-assistant-rail"
      data-motion="rail-transition"
      data-presentation={presentation}
      data-testid="assistant-slot"
      {...(inert ? { inert: true } : {})}
    >
      <header className="assistant-header">
        <div className="assistant-title">
          <span className="assistant-avatar"><Bot size={17} /></span>
          <div>
            <strong>{t("assistant.title")}</strong>
            <span>{thinking ? t("assistant.thinking") : t("assistant.ready")}</span>
          </div>
        </div>
        <ModelSelector models={models} value={modelSelectionId} onChange={setModelSelectionId} />
        {headerActions}
      </header>

      {activeDocumentPath ? (
        onOpenContext ? (
          <button
            className="assistant-context-chip"
            onClick={onOpenContext}
            title={activeDocumentPath}
            type="button"
          >
            <FileText aria-hidden size={13} />
            <span>{activeDocumentPath}</span>
          </button>
        ) : (
          <div className="assistant-context-chip" title={activeDocumentPath}>
            <FileText aria-hidden size={13} />
            <span>{activeDocumentPath}</span>
          </div>
        )
      ) : null}

      {currentSession?.memoryStatus === "degraded" ? (
        <div className="assistant-memory-warning">{t("assistant.memoryUnavailable")}</div>
      ) : null}

      <ChatPanel
        activeDocumentPath={activeDocumentPath}
        currentSession={currentSession}
        hasOlderMessages={hasOlderMessages}
        loadingOlderMessages={loadingOlderMessages}
        messages={messages}
        modelSelection={modelSelection ?? undefined}
        onBusyChange={setBusy}
        onLoadOlderMessages={onLoadOlderMessages}
        onOpenDocumentChange={onOpenDocumentChange}
        project={project}
        accessMode={accessMode}
        composerAutoFocus={presentation === "fullscreen"}
      />
    </aside>
  );
}
