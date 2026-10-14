import * as Dialog from "@radix-ui/react-dialog";
import { LogIn, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { appUrl } from "../config/public-origin";

interface AuthRequiredDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
}

export function AuthRequiredDialog({ open, onOpenChange, title, message }: AuthRequiredDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content community-auth-dialog" data-motion="dialog-settle">
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close aria-label={t("community.auth.close")} className="icon-button" type="button">
              <X size={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description>{message}</Dialog.Description>
          <div className="dialog-actions">
            <Dialog.Close className="secondary-button" type="button">{t("community.auth.later")}</Dialog.Close>
            <a className="primary-button" href={appUrl("/login")}><LogIn size={16} />{t("community.auth.go")}</a>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
