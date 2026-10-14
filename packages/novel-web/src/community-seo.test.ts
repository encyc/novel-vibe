import { describe, expect, it } from "vitest";
import {
  isIndexableArticle,
  renderCommunityArticleDocument,
  renderCommunityIndexDocument,
  renderRobotsTxt,
  renderSitemapXml,
  type CommunitySeoArticle,
} from "./community-seo.js";

const TEMPLATE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>灵器 AI</title>
    <script type="module" src="/assets/index-test.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

const ARTICLE: CommunitySeoArticle = {
  id: "article-1",
  title: "从灵感到成稿",
  excerpt: "完整的 AI 小说创作流程。",
  body: "# 创作流程\n\n正文 **重点**。\n\n<script>alert(1)</script>",
  section: "tools",
  kind: "article",
  publishedAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-10T12:00:00.000Z",
  author: { id: "author-1", nickname: "Justin", isOfficial: true },
  tags: ["平台指南", "AI 小说"],
};

describe("community SEO renderer", () => {
  it("renders unique article metadata, escaped body content, JSON-LD, and the client bundle", () => {
    const html = renderCommunityArticleDocument(TEMPLATE, ARTICLE);

    expect(html).toContain("<title>从灵感到成稿 - AI 小说创作社区 - 灵器 AI</title>");
    expect(html).toContain('rel="canonical" href="https://lingqiai.art/community/article-1"');
    expect(html).toContain('name="description" content="完整的 AI 小说创作流程。"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('"@type":"BlogPosting"');
    expect(html).toContain('"dateModified":"2026-07-10T12:00:00.000Z"');
    expect(html).toContain('<script type="module" src="/assets/index-test.js"></script>');
  });

  it("renders crawlable links and generated excerpts on the community index", () => {
    const html = renderCommunityIndexDocument(TEMPLATE, [
      ARTICLE,
      { ...ARTICLE, id: "article-2", title: "第二篇", excerpt: null, body: undefined },
    ]);

    expect(html).toContain("<title>AI 小说创作社区 - 灵器 AI</title>");
    expect(html).toContain("<h1>AI 小说创作社区</h1>");
    expect(html).toContain('href="/community/article-1"');
    expect(html).toContain("从灵感到成稿");
    expect(html).toContain('rel="canonical" href="https://lingqiai.art/community"');
  });

  it("marks feedback content as non-indexable", () => {
    const feedback = { ...ARTICLE, kind: "bug" as const };
    const html = renderCommunityArticleDocument(TEMPLATE, feedback);

    expect(isIndexableArticle(feedback)).toBe(false);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toContain('"@type":"BlogPosting"');
  });

  it("localizes only SEO chrome and preserves article fields in English", () => {
    const html = renderCommunityArticleDocument(TEMPLATE, ARTICLE, "en");

    expect(html).toContain("<html lang=\"en\">");
    expect(html).toContain("<title>从灵感到成稿 - AI Novel-Writing Community - Lingqi AI</title>");
    expect(html).toContain('name="description" content="完整的 AI 小说创作流程。"');
    expect(html).toContain("<h1>从灵感到成稿</h1>");
    expect(html).toContain("<p>Author: Justin</p>");
    expect(html).toContain("正文 <strong>重点</strong>。");
    expect(html).toContain('"headline":"从灵感到成稿"');
    expect(html).toContain('"keywords":"平台指南, AI 小说"');
    expect(html).toContain('rel="canonical" href="https://lingqiai.art/community/article-1"');
  });

  it("creates plain-text robots rules that expose only public community content", () => {
    const robots = renderRobotsTxt();

    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Disallow: /community/write");
    expect(robots).toContain("Sitemap: https://lingqiai.art/sitemap.xml");
  });

  it("creates escaped, canonical sitemap XML", () => {
    const xml = renderSitemapXml([
      { loc: "https://lingqiai.art/community" },
      { loc: "https://lingqiai.art/community/a&b", lastmod: "2026-07-10T12:00:00.000Z" },
    ]);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("https://lingqiai.art/community/a&amp;b");
    expect(xml).toContain("<lastmod>2026-07-10T12:00:00.000Z</lastmod>");
  });
});
