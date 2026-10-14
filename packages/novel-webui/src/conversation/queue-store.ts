export interface SessionQueue {
  items(): string[];
  enqueue(text: string): void;
  editAt(index: number, text: string): void;
  removeAt(index: number): void;
  shift(): string | undefined;
}

export function createSessionQueue(sessionId: string): SessionQueue {
  const key = `novel-vibe:queue:${sessionId}`;
  const read = (): string[] => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (items: string[]) => {
    try { window.localStorage.setItem(key, JSON.stringify(items)); } catch { /* dropping the queue write is an acceptable fallback */ }
  };
  return {
    items: () => read(),
    enqueue: (text) => write([...read(), text]),
    editAt: (index, text) => write(read().map((item, i) => (i === index ? text : item))),
    removeAt: (index) => write(read().filter((_, i) => i !== index)),
    shift: () => { const items = read(); const head = items.shift(); write(items); return head; },
  };
}
