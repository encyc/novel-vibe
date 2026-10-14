import { BookText, Bot, ClipboardList, Clapperboard, FileDiff, Map, ScrollText, BookOpenText, Sparkles, Users, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentTaskView } from "../assistant/AgentTaskView";
import { ReviewPage } from "../review/ReviewPage";
import type { SessionMessage } from "../types";
import type { DelegationDrillTarget } from "../assistant/delegation-drill";
import { WORKBENCH_MODULES, type WorkbenchModuleId } from "./module-config";
import type { WorkspaceViewId } from "./workspace-view";

const MODULE_ICONS = {
  world: Map,
  characters: Users,
  outline: ScrollText,
  scripts: Clapperboard,
  chapters: BookOpenText,
  continuity: ClipboardList,
  lingqi: Sparkles,
} as const;

interface WorkspacePanelProps {
  activeView: WorkspaceViewId;
  /** Route module currently open in the workspace pane (rail highlight). */
  activeModuleId: string | null;
  /** Whether the module's slide-out document list is expanded. */
  docRailOpen: boolean;
  /** Conversation transcripts feeding the review page. */
  messages: SessionMessage[];
  onViewChange: (view: WorkspaceViewId) => void;
  onModuleSelect: (moduleId: string) => void;
  /** Active delegation drill opened from the conversation trace; enables the agent page. */
  drill: DelegationDrillTarget | null;
  /** Version requested from the conversation (document change card). */
  focusVersionId: string | null;
  onCloseDrill: () => void;
  onCollapse: () => void;
  /** Toggle the active module's slide-out document list. */
  onDocRailToggle: () => void;
  /**
   * The routed workspace subtree. Rendered on every tick of this component so
   * a hidden page keeps its state — an unsaved manuscript must never remount
   * just because the reader peeked at another page.
   */
  workspace: ReactNode;
}

/**
 * better-DSH-sidebar shape: pages live on a right-edge icon rail (one icon per
 * creative module, plus review and the transient agent task); the pane sits to
 * the left. Clicking the active icon collapses the pane, exactly like the
 * plugin's activity bar.
 */
export function WorkspacePanel({
  activeModuleId,
  activeView,
  docRailOpen,
  drill,
  focusVersionId,
  messages,
  onCloseDrill,
  onCollapse,
  onDocRailToggle,
  onModuleSelect,
  onViewChange,
  workspace,
}: WorkspacePanelProps) {
  const { t } = useTranslation();
  const reviewActive = activeView === "review";
  const agentActive = activeView === "agent";

  return (
    <div className="workspace-panel">
      <div className="workspace-panel-body">
        <div className="workspace-pane" hidden={!agentActive}>
          {drill ? (
            <AgentTaskView
              onBack={onCloseDrill}
              sessionId={drill.sessionId}
              target={drill}
            />
          ) : null}
        </div>
        <div className="workspace-pane" hidden={!reviewActive}>
          <ReviewPage focusVersionId={focusVersionId} messages={messages} />
        </div>
        <div className="workspace-pane" hidden={agentActive || reviewActive}>
          {workspace}
        </div>
      </div>
      <nav aria-label={t("workbench.creativeArea")} className="workspace-rail">
        {WORKBENCH_MODULES.filter((module) => module.id !== "overview").map((module) => {
          const Icon = MODULE_ICONS[module.id as Exclude<WorkbenchModuleId, "overview">];
          const active = activeView === "workspace" && activeModuleId === module.id;
          return (
            <button
              aria-expanded={active ? docRailOpen : undefined}
              aria-label={t(module.labelKey)}
              aria-pressed={active}
              className="workspace-rail-item"
              data-active={active || undefined}
              key={module.id}
              onClick={() => (active ? onDocRailToggle() : onModuleSelect(module.id))}
              data-tip={t(module.labelKey)}
              type="button"
            >
              <Icon aria-hidden size={17} />
            </button>
          );
        })}
        <span className="workspace-rail-gap" />
        <button
          aria-label={t("workbench.tabs.review")}
          aria-pressed={reviewActive}
          className="workspace-rail-item"
          data-active={reviewActive || undefined}
          onClick={() => (reviewActive ? onCollapse() : onViewChange("review"))}
          data-tip={t("workbench.tabs.review")}
          type="button"
        >
          <FileDiff aria-hidden size={17} />
        </button>
        {drill ? (
          <button
            aria-label={t("workbench.tabs.agent")}
            aria-pressed={agentActive}
            className="workspace-rail-item"
            data-active={agentActive || undefined}
            onClick={() => (agentActive ? onCollapse() : onViewChange("agent"))}
            data-tip={t("workbench.tabs.agent")}
            type="button"
          >
            <Bot aria-hidden size={17} />
            {drill.isRunningNow?.() || drill.summary?.running ? <i className="session-processing-dot" /> : null}
          </button>
        ) : null}
        <span className="workspace-rail-gap" />
        <button
          aria-label={t("workbench.tabs.closePanel")}
          className="workspace-rail-item"
          onClick={onCollapse}
          data-tip={t("workbench.tabs.closePanel")}
          type="button"
        >
          <X aria-hidden size={16} />
        </button>
      </nav>
    </div>
  );
}
