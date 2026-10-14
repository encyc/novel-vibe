import { Pencil, Send, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionQueue } from "./queue-store";

interface QueueDockProps {
  queue: SessionQueue;
  revision: number;
  onSendNow(text: string): void;
  onChange(): void;
}

export function QueueDock({ onChange, onSendNow, queue, revision }: QueueDockProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const items = queue.items();
  if (!items.length) return null;
  return (
    <div aria-label={t("assistant.queue.label")} className="queue-dock" data-motion="drawer-reveal" role="list">
      <header><strong>{t("assistant.queue.title", { count: items.length })}</strong><span data-revision={revision} /></header>
      {items.map((item, index) => (
        <div className="queue-dock-row" key={`${index}:${item.slice(0, 8)}`} role="listitem">
          {editing === index ? (
            <form onSubmit={(event) => { event.preventDefault(); const next = draft.trim(); if (!next) return; queue.editAt(index, next); setEditing(null); onChange(); }}>
              <input aria-label={t("assistant.queue.edit")} autoFocus onChange={(event) => setDraft(event.target.value)} value={draft} />
            </form>
          ) : (
            <>
              <span>{item}</span>
              <button aria-label={t("assistant.queue.edit")} onClick={() => { setEditing(index); setDraft(item); }} type="button"><Pencil size={13} /></button>
              <button aria-label={t("assistant.queue.sendNow")} onClick={() => { queue.removeAt(index); onChange(); onSendNow(item); }} type="button"><Send size={13} /></button>
              <button aria-label={t("assistant.queue.remove")} onClick={() => { queue.removeAt(index); onChange(); }} type="button"><X size={13} /></button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
