const COMMUNITY_ORIGIN = "https://lingqiai.art";
export type CommunitySeoLocale = "zh-CN" | "en";

const SEO_COPY = {
  "zh-CN": {
    siteName: "灵器 AI",
    community: "AI 小说创作社区",
    indexDescription: "灵器 AI 小说创作社区，交流 AI 小说写作、世界观构建、人物设计、大纲规划、长篇一致性与完整创作流程。",
    indexIntro: "交流 AI 小说写作方法、创作工具与完整工作流。",
    brand: "灵器社区",
    articles: "社区文章",
    breadcrumb: "面包屑",
    author: "作者：",
    fallback: "，来自灵器 AI 小说创作社区。",
  },
  en: {
    siteName: "Lingqi AI",
    community: "AI Novel-Writing Community",
    indexDescription: "The Lingqi AI community for AI novel writing, worldbuilding, character design, outlining, continuity, and complete writing workflows.",
    indexIntro: "Share AI novel-writing methods, creative tools, and complete workflows.",
    brand: "Lingqi Community",
    articles: "Community articles",
    breadcrumb: "Breadcrumb",
    author: "Author: ",
    fallback: ", from the Lingqi AI novel-writing community.",
  },
} as const;

export function normalizeCommunitySeoLocale(value: string | string[] | undefined): CommunitySeoLocale {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

export interface CommunitySeoArticle {
  id: string;
  title: string;
  excerpt: string | null;
  body?: string;
  section?: string | null;
  kind: "article" | "announcement" | "bug" | "feature_request";
  publishedAt: string | null;
  updatedAt?: string | null;
  author: { id: string; nickname: string; isOfficial: boolean };
  tags: string[];
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string | null;
}

export function isIndexableArticle(article: CommunitySeoArticle): boolean {
  return (article.kind === "article" || article.kind === "announcement")
    && Boolean(article.publishedAt)
    && Boolean(article.title.trim());
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function renderInline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
      list = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 5);
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }
    if (/^---+$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push("<hr>");
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks.join("\n");
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[>*_~|#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function descriptionFor(article: CommunitySeoArticle, locale: CommunitySeoLocale): string {
  const source = article.excerpt?.trim() || plainText(article.body ?? "")
    || `${article.title}${SEO_COPY[locale].fallback}`;
  return Array.from(source).slice(0, 160).join("");
}

function cleanSeoHead(template: string): string {
  return template
    .replace(/\s*<meta\s+name=["'](?:description|robots)["'][^>]*>/gi, "")
    .replace(/\s*<meta\s+property=["']og:[^"']+["'][^>]*>/gi, "")
    .replace(/\s*<link\s+rel=["']canonical["'][^>]*>/gi, "")
    .replace(/\s*<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, "");
}

function injectDocument(
  template: string,
  input: {
    title: string;
    description: string;
    canonical: string;
    robots: "index, follow" | "noindex, nofollow";
    body: string;
    locale: CommunitySeoLocale;
    jsonLd?: unknown;
  },
): string {
  let html = cleanSeoHead(template)
    .replace(/<html([^>]*)\slang=["'][^"']*["']([^>]*)>/i, `<html$1 lang="${input.locale}"$2>`)
    .replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeHtml(input.title)}</title>`,
  );
  const head = [
    `<meta name="description" content="${escapeHtml(input.description)}">`,
    `<meta name="robots" content="${input.robots}">`,
    `<link rel="canonical" href="${escapeHtml(input.canonical)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${escapeHtml(input.title)}">`,
    `<meta property="og:description" content="${escapeHtml(input.description)}">`,
    `<meta property="og:url" content="${escapeHtml(input.canonical)}">`,
    `<meta property="og:site_name" content="${escapeHtml(SEO_COPY[input.locale].siteName)}">`,
    input.jsonLd
      ? `<script type="application/ld+json">${safeJson(input.jsonLd)}</script>`
      : "",
  ].filter(Boolean).join("\n    ");
  html = html.replace(/<\/head>/i, `    ${head}\n  </head>`);
  return html.replace(
    /<div\s+id=["']root["']\s*><\/div>/i,
    `<div id="root">${input.body}</div>`,
  );
}

export function renderCommunityIndexDocument(
  template: string,
  articles: CommunitySeoArticle[],
  locale: CommunitySeoLocale = "zh-CN",
): string {
  const copy = SEO_COPY[locale];
  const indexable = articles.filter(isIndexableArticle);
  const cards = indexable.map((article) => {
    const description = descriptionFor(article, locale);
    const date = article.publishedAt
      ? `<time datetime="${escapeHtml(article.publishedAt)}">${escapeHtml(article.publishedAt.slice(0, 10))}</time>`
      : "";
    return `<article>
      <h2><a href="/community/${encodeURIComponent(article.id)}">${escapeHtml(article.title)}</a></h2>
      <p>${escapeHtml(description)}</p>
      <p>${escapeHtml(article.author.nickname)} ${date}</p>
    </article>`;
  }).join("\n");
  const canonical = `${COMMUNITY_ORIGIN}/community`;
  return injectDocument(template, {
    title: `${copy.community} - ${copy.siteName}`,
    description: copy.indexDescription,
    canonical,
    locale,
    robots: "index, follow",
    body: `<main class="community-seo-shell">
      <header><a href="${COMMUNITY_ORIGIN}/community">${copy.brand}</a></header>
      <h1>${copy.community}</h1>
      <p>${copy.indexIntro}</p>
      <section aria-label="${copy.articles}">${cards}</section>
    </main>`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: copy.community,
      url: canonical,
    },
  });
}

export function renderCommunityArticleDocument(
  template: string,
  article: CommunitySeoArticle,
  locale: CommunitySeoLocale = "zh-CN",
): string {
  const copy = SEO_COPY[locale];
  const canonical = `${COMMUNITY_ORIGIN}/community/${encodeURIComponent(article.id)}`;
  const indexable = isIndexableArticle(article);
  const description = descriptionFor(article, locale);
  const jsonLd = indexable ? {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: article.title,
    description,
    url: canonical,
    mainEntityOfPage: canonical,
    datePublished: article.publishedAt,
    dateModified: article.updatedAt || article.publishedAt,
    author: { "@type": "Person", name: article.author.nickname },
    publisher: { "@type": "Organization", name: copy.siteName, url: "https://lingqiai.art/" },
    keywords: article.tags.join(", "),
  } : undefined;

  return injectDocument(template, {
    title: `${article.title} - ${copy.community} - ${copy.siteName}`,
    description,
    canonical,
    locale,
    robots: indexable ? "index, follow" : "noindex, nofollow",
    jsonLd,
    body: `<main class="community-seo-shell">
      <nav aria-label="${copy.breadcrumb}"><a href="/community">${copy.community}</a></nav>
      <article>
        <h1>${escapeHtml(article.title)}</h1>
        <p>${copy.author}${escapeHtml(article.author.nickname)}</p>
        ${article.publishedAt ? `<time datetime="${escapeHtml(article.publishedAt)}">${escapeHtml(article.publishedAt.slice(0, 10))}</time>` : ""}
        <div class="community-seo-article-body">${renderMarkdown(article.body ?? "")}</div>
      </article>
    </main>`,
  });
}

export function renderRobotsTxt(): string {
  return [
    "User-agent: *",
    "Allow: /community",
    "Disallow: /api/",
    "Disallow: /login",
    "Disallow: /projects",
    "Disallow: /profile",
    "Disallow: /skills",
    "Disallow: /community/write",
    "Disallow: /community/edit/",
    "Disallow: /community/my-feedback",
    "Disallow: /community/author/",
    "",
    `Sitemap: ${COMMUNITY_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

export function renderSitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : "";
    return `  <url><loc>${escapeXml(entry.loc)}</loc>${lastmod}</url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
