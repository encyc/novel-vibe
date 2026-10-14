import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocumentDiffLine, DocumentDiffPage, DocumentVersionSummary } from "../types";

interface DocumentDiffViewerProps {
  version: DocumentVersionSummary;
  pages: DocumentDiffPage[];
  loading: boolean;
  error?: string;
  hasMore: boolean;
  onLoadMore(): void;
  onClose(): void;
}

function marker(line: DocumentDiffLine) {
  return line.kind === "insert" ? "+" : line.kind === "delete" ? "−" : " ";
}

export function DocumentDiffViewer(props: DocumentDiffViewerProps) {
  const { t } = useTranslation();
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [current, setCurrent] = useState(0);
  const hunkRefs = useRef<Array<HTMLElement | null>>([]);
  const hunks = props.pages.flatMap((page) => page.items);
  const properties = props.pages.flatMap((page) => page.frontmatterChanges);
  const truncated = props.pages.some((page) => page.truncated);
  const unavailable = props.version.diffStatus === "unavailable" || props.pages.some((page) => page.status === "unavailable");
  const copyText = useMemo(() => hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart} +${hunk.newStart} @@${hunk.section ? ` ${hunk.section}` : ""}`,
    ...hunk.lines.map((line) => `${marker(line) === "−" ? "-" : marker(line)} ${line.text}`),
  ]).join("\n"), [hunks]);

  useEffect(() => {
    hunkRefs.current[current]?.scrollIntoView?.({ block: "center" });
  }, [current]);

  if (props.loading && !hunks.length) return <section className="document-diff-viewer"><p>{t("workbench.document.versions.loading")}</p></section>;
  if (props.error) return <section className="document-diff-viewer"><p role="alert">{props.error}</p><button onClick={props.onClose} type="button">{t("workbench.document.versions.close")}</button></section>;
  if (unavailable) return <section className="document-diff-viewer"><p>{t("workbench.document.versions.repair")}</p><button onClick={props.onClose} type="button">{t("workbench.document.versions.close")}</button></section>;

  const move = (delta: number) => setCurrent((value) => Math.min(Math.max(value + delta, 0), Math.max(hunks.length - 1, 0)));
  return (
    <section aria-label={t("workbench.document.versions.diff")} className="document-diff-viewer">
      <header>
        <div><strong>{t("workbench.document.versions.version", { version: props.version.versionNo })}</strong><span>{t("workbench.document.versions.stats", { added: props.version.addedLines, deleted: props.version.deletedLines })}</span></div>
        <button onClick={props.onClose} type="button">{t("workbench.document.versions.close")}</button>
      </header>
      <nav aria-label={t("workbench.document.versions.navigation")}>
        <button disabled={current === 0} onClick={() => move(-1)} type="button">{t("workbench.document.versions.previous")}</button>
        <span>{hunks.length ? current + 1 : 0} / {hunks.length}</span>
        <button disabled={current >= hunks.length - 1} onClick={() => move(1)} type="button">{t("workbench.document.versions.next")}</button>
        <button onClick={() => void navigator.clipboard.writeText(copyText)} type="button">{t("workbench.document.versions.copy")}</button>
      </nav>
      {properties.length ? (
        <section className="document-diff-properties">
          <button aria-expanded={propertiesOpen} onClick={() => setPropertiesOpen((value) => !value)} type="button">
            {propertiesOpen ? t("workbench.document.versions.collapseProperties") : t("workbench.document.versions.expandProperties")}
          </button>
          {propertiesOpen ? <dl>{properties.map((change) => <div key={`${change.key}:${change.kind}`}><dt>{change.key}</dt><dd>{JSON.stringify(change.before)} → {JSON.stringify(change.after)}</dd></div>)}</dl> : null}
        </section>
      ) : null}
      <ol className="document-diff-hunks">
        {hunks.map((hunk, hunkIndex) => (
          <li key={`${hunk.index}:${hunk.oldStart}:${hunk.newStart}`} ref={(node) => { hunkRefs.current[hunkIndex] = node; }}>
            <h3>@@ -{hunk.oldStart} +{hunk.newStart} @@{hunk.section ? ` ${hunk.section}` : ""}</h3>
            <ol>
              {hunk.lines.map((line, lineIndex) => {
                const lineNo = line.kind === "delete" ? line.oldLine : line.newLine;
                const aria = line.kind === "insert" ? t("workbench.document.versions.insertLine", { line: lineNo }) : line.kind === "delete" ? t("workbench.document.versions.deleteLine", { line: lineNo }) : undefined;
                return <li className={`diff-line ${line.kind}`} data-kind={line.kind} key={`${line.kind}:${line.oldLine}:${line.newLine}:${lineIndex}`}><span aria-label={aria}>{marker(line)}</span><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><code>{line.spans?.length ? line.spans.map((span, index) => <span className={`inline-${span.kind}`} key={index}>{span.text}</span>) : line.text}</code></li>;
              })}
            </ol>
          </li>
        ))}
      </ol>
      {truncated ? <p className="document-diff-omitted">{t("workbench.document.versions.omitted")}</p> : null}
      {props.hasMore ? <button disabled={props.loading} onClick={props.onLoadMore} type="button">{t("workbench.document.versions.loadMore")}</button> : null}
    </section>
  );
}
