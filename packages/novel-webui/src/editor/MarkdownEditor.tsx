import { markdown } from "@codemirror/lang-markdown";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  readOnly?: boolean;
}

const sereneEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--alias-label-primary)",
    backgroundColor: "transparent",
    fontSize: "var(--editor-font-size)",
  },
  ".cm-content": {
    padding: "var(--editor-content-padding)",
    caretColor: "var(--alias-accent)",
    fontFamily: "var(--font-ui)",
    lineHeight: "var(--editor-line-height)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-sage-900)",
  },
  ".cm-gutters": {
    color: "var(--color-muted)",
    backgroundColor: "var(--color-surface)",
    border: "0",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "transparent",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--color-sage-100)",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

function frontmatterLineRange(state: EditorState): [number, number] | null {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return null;
  for (let n = 2; n <= doc.lines; n++) {
    if (doc.line(n).text.trim() === "---") return [1, n];
  }
  return null;
}

function frontmatterDecorations(state: EditorState): DecorationSet {
  const range = frontmatterLineRange(state);
  if (!range) return Decoration.none;
  const [first, last] = range;
  const marks = [];
  for (let n = first; n <= last; n++) {
    marks.push(Decoration.line({ class: "cm-frontmatter-line" }).range(state.doc.line(n).from));
  }
  return Decoration.set(marks, true);
}

/**
 * Paints the YAML frontmatter block as a distinct metadata zone while it
 * stays fully editable source — the writer sees where the document's system
 * header ends and the prose begins without losing direct control of the YAML.
 */
const frontmatterHighlight = EditorView.decorations.compute(["doc"], (state) => frontmatterDecorations(state));

export function MarkdownEditor({ value, onChange, readOnly = false }: MarkdownEditorProps) {
  const { t } = useTranslation();
  const editorExtensions = useMemo(() => [
    markdown(),
    EditorView.lineWrapping,
    // Browser spellcheck paints wavy underlines across every Chinese prose
    // line and the YAML keys; it renders the manuscript as a typo field.
    EditorView.contentAttributes.of({
      "aria-label": t("workbench.document.sourceAria"),
      spellcheck: "false",
    }),
    frontmatterHighlight,
  ], [t]);
  return (
    <CodeMirror
      basicSetup={{ foldGutter: false, highlightActiveLine: false }}
      className="markdown-editor"
      extensions={editorExtensions}
      height="100%"
      onChange={onChange}
      readOnly={readOnly}
      theme={sereneEditorTheme}
      value={value}
    />
  );
}
