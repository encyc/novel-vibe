import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";
import { splitFrontmatter } from "./frontmatter";

interface MarkdownPreviewProps {
  content: string;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const { t } = useTranslation();
  const frontmatter = splitFrontmatter(content);
  const fieldCount = frontmatter
    ? frontmatter.yaml.split("\n").filter((line) => !/^\s/.test(line)).length
    : 0;
  return (
    <article aria-label={t("workbench.document.previewAria")} className="markdown-preview">
      {frontmatter ? (
        <details className="frontmatter-card">
          <summary>
            <span className="frontmatter-card-title">{t("workbench.document.frontmatterTitle")}</span>
            <span className="frontmatter-card-meta">{t("workbench.document.frontmatterFields", { count: fieldCount })}</span>
          </summary>
          <pre className="frontmatter-card-body">{frontmatter.yaml}</pre>
        </details>
      ) : null}
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{frontmatter ? frontmatter.body : content}</ReactMarkdown>
    </article>
  );
}
