import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface WorkspaceColophonProps {
  children?: ReactNode;
  detail?: string;
  eyebrow: string;
  title: string;
}

export function WorkspaceColophon({ children, detail, eyebrow, title }: WorkspaceColophonProps) {
  const { t } = useTranslation();
  return (
    <header aria-label={t("workbench.workspaceAria", { title })} className="workspace-colophon">
      <div className="workspace-colophon-copy">
        <span className="workspace-colophon-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {detail ? <p title={detail}>{detail}</p> : null}
      </div>
      {children ? <div className="workspace-colophon-actions">{children}</div> : null}
    </header>
  );
}
