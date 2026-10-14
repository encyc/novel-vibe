import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface UnsavedChangesContextValue {
  dirty: boolean;
  setDirty(value: boolean): void;
  runAfterDiscard(action: () => void): void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

export function useUnsavedChanges(): UnsavedChangesContextValue {
  const context = useContext(UnsavedChangesContext);
  if (!context) throw new Error("useUnsavedChanges must be used within UnsavedChangesProvider");
  return context;
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  const runAfterDiscard = useCallback((action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    pendingAction.current = action;
    setOpen(true);
  }, [dirty]);

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) pendingAction.current = null;
  }

  function discard() {
    const action = pendingAction.current;
    pendingAction.current = null;
    setOpen(false);
    setDirty(false);
    action?.();
  }

  return (
    <UnsavedChangesContext.Provider value={{ dirty, runAfterDiscard, setDirty }}>
      {children}
      <Dialog.Root onOpenChange={changeOpen} open={open}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" data-motion="dialog-settle">
            <div className="dialog-heading">
              <Dialog.Title>{t("workbench.unsaved.title")}</Dialog.Title>
              <Dialog.Close asChild>
                <button aria-label={t("workbench.unsaved.close")} className="icon-button" type="button"><X size={16} /></button>
              </Dialog.Close>
            </div>
            <Dialog.Description>
              {t("workbench.unsaved.description")}
            </Dialog.Description>
            <div className="dialog-actions">
              <Dialog.Close className="secondary-button">{t("workbench.unsaved.continueEditing")}</Dialog.Close>
              <button className="danger-button" onClick={discard} type="button">{t("workbench.unsaved.discard")}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </UnsavedChangesContext.Provider>
  );
}
