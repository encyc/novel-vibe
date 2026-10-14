import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  children: string;
  live?: boolean;
}

/**
 * Lightweight markdown renderer for chat messages.
 * Wraps react-markdown + remark-gfm (GFM tables, strikethrough, task lists).
 * Keep this self-contained so chat-message rendering stays easy to merge.
 */
export function Markdown({ children, live = false }: MarkdownProps) {
  return (
    <div aria-live={live ? "polite" : undefined} className="assistant-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
