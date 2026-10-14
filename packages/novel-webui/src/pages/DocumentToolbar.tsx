import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Download, File, FileText, FileType, MoreHorizontal, RefreshCw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Spinner } from "../ui/Spinner";
import { IconButton } from "../ui/IconButton";

export type ViewMode = "edit" | "preview";
export type SaveState = "loading" | "saved" | "unsaved" | "saving" | "failed" | "conflict";
export type DocumentExportFormat = "md" | "txt" | "docx";

export interface DocumentToolbarProps {
  canDelete: boolean;
  canExport: boolean;
  canSave: boolean;
  exportAllowed: boolean;
  exporting: boolean;
  loading: boolean;
  mobile: boolean;
  onDelete: () => void;
  onExport: (format: DocumentExportFormat) => void;
  onRefresh: () => void;
  onSave: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  saveLabel: string;
  saveState: SaveState;
  viewMode: ViewMode;
}

function ExportItems({ disabled, onExport }: { disabled: boolean; onExport: (format: DocumentExportFormat) => void }) {
  const { t } = useTranslation();
  return <>
    <DropdownMenu.Item className="dropdown-item" disabled={disabled} onSelect={() => onExport("md")}>
      <FileText aria-hidden="true" size={14} /> Markdown (.md)
    </DropdownMenu.Item>
    <DropdownMenu.Item className="dropdown-item" disabled={disabled} onSelect={() => onExport("txt")}>
      <File aria-hidden="true" size={14} /> {t("workbench.document.plainText")}
    </DropdownMenu.Item>
    <DropdownMenu.Item className="dropdown-item" disabled={disabled} onSelect={() => onExport("docx")}>
      <FileType aria-hidden="true" size={14} /> Word (.docx)
    </DropdownMenu.Item>
  </>;
}

export function DocumentToolbar({
  canDelete,
  canExport,
  canSave,
  exportAllowed,
  exporting,
  loading,
  mobile,
  onDelete,
  onExport,
  onRefresh,
  onSave,
  onViewModeChange,
  saveLabel,
  saveState,
  viewMode,
}: DocumentToolbarProps) {
  const { t } = useTranslation();
  return (
    <div className="document-actions" data-mobile={mobile || undefined}>
      <div aria-label={t("workbench.document.view")} className="view-mode-control" data-motion="view-crossfade" data-view={viewMode} role="group">
        <button aria-pressed={viewMode === "edit"} onClick={() => onViewModeChange("edit")} type="button">{t("workbench.document.edit")}</button>
        <button aria-pressed={viewMode === "preview"} onClick={() => onViewModeChange("preview")} type="button">{t("workbench.document.preview")}</button>
      </div>
      <span className="save-state" data-state={saveState}>{saveLabel}</span>
      {loading ? <Spinner label={t("workbench.document.loading")} /> : null}

      {mobile ? <>
        <IconButton disabled={!canSave} label={t("workbench.document.save")} onClick={onSave}><Save size={17} /></IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label={t("workbench.mobile.moreDocumentActions")}><MoreHorizontal size={19} /></IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="dropdown-content" sideOffset={4}>
              <ExportItems disabled={!canExport || exporting} onExport={onExport} />
              <DropdownMenu.Separator className="dropdown-separator" />
              <DropdownMenu.Item className="dropdown-item" onSelect={onRefresh}>
                <RefreshCw aria-hidden="true" size={14} /> {t("workbench.document.refresh")}
              </DropdownMenu.Item>
              <DropdownMenu.Item className="dropdown-item danger" disabled={!canDelete} onSelect={onDelete}>
                <Trash2 aria-hidden="true" size={14} /> {t("workbench.document.delete")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </> : <>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton disabled={!canExport || exporting} label={exportAllowed ? t("workbench.document.export") : t("workbench.document.exportMembersOnly")}>
              <Download size={16} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="dropdown-content" sideOffset={4}>
              <ExportItems disabled={!canExport || exporting} onExport={onExport} />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <IconButton label={t("workbench.document.refresh")} onClick={onRefresh}><RefreshCw size={16} /></IconButton>
        <button
          className="document-save-button"
          data-dirty={saveState === "unsaved" || saveState === "failed" ? true : undefined}
          disabled={!canSave}
          onClick={onSave}
          type="button"
        >
          <Save aria-hidden="true" size={14} />
          {t("workbench.document.save")}
        </button>
        <IconButton disabled={!canDelete} label={t("workbench.document.delete")} onClick={onDelete} tone="danger"><Trash2 size={16} /></IconButton>
      </>}
    </div>
  );
}
