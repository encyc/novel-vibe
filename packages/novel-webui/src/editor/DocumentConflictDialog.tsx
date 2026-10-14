import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DocumentConflict } from "../types";
import { IconButton } from "../ui/IconButton";

interface DocumentConflictDialogProps {
  conflict: DocumentConflict | null;
  localContent: string;
  onKeepLocal(): void;
  onReloadRemote(): void;
}

export function DocumentConflictDialog({
  conflict,
  localContent,
  onKeepLocal,
  onReloadRemote,
}: DocumentConflictDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root onOpenChange={(open) => { if (!open) onKeepLocal(); }} open={Boolean(conflict)}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content conflict-dialog" data-motion="dialog-settle">
          <div className="dialog-heading">
            <Dialog.Title>{t("workbench.document.conflict.title")}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label={t("workbench.document.conflict.close")}><X size={16} /></IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description>
            {t("workbench.document.conflict.description")}
          </Dialog.Description>
          <div className="conflict-versions">
            <label>{t("workbench.document.conflict.local")}<textarea readOnly value={localContent} /></label>
            <label>{t("workbench.document.conflict.remote")}<textarea readOnly value={conflict?.content ?? ""} /></label>
          </div>
          <div className="dialog-actions">
            <button className="secondary-button" onClick={onKeepLocal} type="button">{t("workbench.document.conflict.keepLocal")}</button>
            <button className="primary-button" onClick={onReloadRemote} type="button">{t("workbench.document.conflict.reloadRemote")}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
