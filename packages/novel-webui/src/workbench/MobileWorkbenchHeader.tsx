import { BookOpenText, Menu } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/IconButton";

interface MobileWorkbenchHeaderProps {
  detailOpen: boolean;
  contextOpen: boolean;
  moduleLabel: string;
  onDetailOpenChange: (open: boolean) => void;
  onContextOpenChange: (open: boolean) => void;
  projectTitle: string;
}

export function MobileWorkbenchHeader({
  detailOpen,
  contextOpen,
  moduleLabel,
  onDetailOpenChange,
  onContextOpenChange,
  projectTitle,
}: MobileWorkbenchHeaderProps) {
  const { t } = useTranslation();
  const navigationControlRef = useRef<HTMLSpanElement>(null);
  const workspaceControlRef = useRef<HTMLSpanElement>(null);
  const wasContextOpen = useRef(contextOpen);
  const wasDetailOpen = useRef(detailOpen);

  useEffect(() => {
    if (wasContextOpen.current && !contextOpen) {
      navigationControlRef.current?.querySelector("button")?.focus();
    }
    wasContextOpen.current = contextOpen;
  }, [contextOpen]);

  useEffect(() => {
    if (wasDetailOpen.current && !detailOpen) {
      workspaceControlRef.current?.querySelector("button")?.focus();
    }
    wasDetailOpen.current = detailOpen;
  }, [detailOpen]);

  return (
    <header aria-label={t("workbench.mobile.header")} className="mobile-workbench-header">
      <span className="mobile-navigation-trigger" ref={navigationControlRef}>
        <IconButton
          aria-expanded={contextOpen}
          label={t("workbench.mobile.openNavigation")}
          onClick={() => onContextOpenChange(!contextOpen)}
        >
          <Menu size={20} />
        </IconButton>
      </span>
      <div className="mobile-workbench-title">
        <strong>{moduleLabel}</strong>
        <span>{projectTitle}</span>
      </div>
      <span className="mobile-workspace-trigger" ref={workspaceControlRef}>
        <IconButton
          aria-pressed={detailOpen}
          label={t(detailOpen ? "workbench.collapseWorkspace" : "workbench.expandWorkspace")}
          onClick={() => onDetailOpenChange(!detailOpen)}
        >
          <BookOpenText size={20} />
        </IconButton>
      </span>
    </header>
  );
}
