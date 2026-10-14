/**
 * Web tools: search the public web and fetch page content.
 *
 * Provides web_search and web_fetch tools for the Chief Editor to
 * gather external information (research, fact-checking, references).
 *
 * Provider interface is designed for future multi-provider support
 * (Tavily / Brave / Exa). MVP uses Tavily only.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./file-tools.js";

// ─── Provider interfaces ──────────────────────────────────────────

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebFetchResult {
  title?: string;
  text: string;
  url: string;
}

export interface WebSearchProvider {
  search(query: string, maxResults: number): Promise<WebSearchResultItem[]>;
}

export interface WebFetchProvider {
  fetch(url: string): Promise<WebFetchResult>;
}

type WebSearchAccessCode =
  | "MEMBERSHIP_REQUIRED"
  | "WEB_SEARCH_AUTHORIZATION_UNAVAILABLE";

class WebSearchAccessError extends Error {
  constructor(readonly code: WebSearchAccessCode, message: string) {
    super(message);
  }
}

async function assertWebSearchEntitlement(ctx: ToolContext): Promise<void> {
  if (!ctx.userId) {
    throw new WebSearchAccessError(
      "MEMBERSHIP_REQUIRED",
      "联网搜索是会员功能，请提示用户开通会员；不要重复调用。",
    );
  }

  // The port is the only membership source here: lookup failures must stay
  // distinguishable from "not entitled", so the error is not folded into `false`.
  let allowed: boolean;
  try {
    allowed = await ctx.entitlements.has(ctx.userId, "web_search");
  } catch {
    throw new WebSearchAccessError(
      "WEB_SEARCH_AUTHORIZATION_UNAVAILABLE",
      "联网搜索权限暂时无法验证，请稍后再试；不要重复调用。",
    );
  }

  if (!allowed) {
    throw new WebSearchAccessError(
      "MEMBERSHIP_REQUIRED",
      "联网搜索是会员功能，请提示用户开通会员；不要重复调用。",
    );
  }
}

function webSearchAccessErrorResult(error: unknown) {
  if (!(error instanceof WebSearchAccessError)) return null;
  return {
    content: [{ type: "text" as const, text: `${error.code}: ${error.message}` }],
    details: {
      error: true,
      code: error.code,
      feature: "web_search",
    },
    isError: true,
  };
}

// ─── Tavily provider ──────────────────────────────────────────────

let _tavilyClient: any = undefined;

async function getTavilyClient(): Promise<any> {
  if (_tavilyClient) return _tavilyClient;
  const { tavily } = await import("@tavily/core");
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not configured");
  _tavilyClient = tavily({ apiKey });
  return _tavilyClient;
}

function createTavilyProvider(): WebSearchProvider & WebFetchProvider {
  return {
    async search(query: string, maxResults: number): Promise<WebSearchResultItem[]> {
      const client = await getTavilyClient();
      const response = await client.search(query, {
        maxResults,
        searchDepth: "basic",
      });
      return (response.results ?? []).map((r: any) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        publishedAt: r.published_date,
      }));
    },

    async fetch(url: string): Promise<WebFetchResult> {
      const client = await getTavilyClient();
      const response = await client.extract([url]);
      const result = (response.results ?? [])[0] ?? {};
      return {
        title: result.title,
        text: result.raw_content ?? "",
        url,
      };
    },
  };
}

// ─── In-memory cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

function createSearchCache(ttlMs: number) {
  const cache = new Map<string, CacheEntry<WebSearchResultItem[]>>();

  return {
    get(key: string): WebSearchResultItem[] | undefined {
      const entry = cache.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return undefined;
      }
      return entry.data;
    },
    set(key: string, data: WebSearchResultItem[]): void {
      cache.set(key, { data, expiresAt: Date.now() + ttlMs });
    },
  };
}

// ─── Result formatting ────────────────────────────────────────────

function formatSearchResults(
  results: (WebSearchResultItem & { id: string })[],
  prefix: string,
): string {
  if (results.length === 0) return "No results found.";

  const lines: string[] = [];
  for (const r of results) {
    const date = r.publishedAt ? ` (${r.publishedAt})` : "";
    lines.push(`[${r.id}] **${r.title}**${date}`);
    lines.push(`    ${r.url}`);
    lines.push(`    ${r.snippet}`);
    lines.push("");
  }

  const header =
    `Found ${results.length} result(s). Open promising URLs with web_fetch to read full content.\n` +
    `When answering, cite sources with [${prefix}_1], [${prefix}_2], etc.\n\n`;
  return header + lines.join("\n");
}

// ─── web_search tool ──────────────────────────────────────────────

const webSearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  maxResults: Type.Optional(
    Type.Number({ default: 5, description: "Maximum number of results (1–10)" }),
  ),
});

export function createWebSearchTool(
  ctx: ToolContext,
  provider?: WebSearchProvider,
): AgentTool<typeof webSearchParams> {
  const searchProvider = provider ?? createTavilyProvider();
  const cache = createSearchCache(10 * 60 * 1000); // 10 min TTL

  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web for recent or external information. " +
      "Returns title, URL, and snippet for each result. " +
      "Use web_fetch to read full page content from promising URLs. " +
      "Always cite sources as [web_N] in your answer.",
    parameters: webSearchParams,
    execute: async (_toolCallId, params) => {
      try {
        await assertWebSearchEntitlement(ctx);
        const max = Math.min(Math.max(params.maxResults ?? 5, 1), 10);
        const cacheKey = `q=${params.query}|n=${max}`;

        const cached = cache.get(cacheKey);
        if (cached) {
          const items = cached.map((r, i) => ({ ...r, id: `web_${i + 1}` }));
          return {
            content: [{ type: "text" as const, text: formatSearchResults(items, "web") }],
            details: { results: items, cached: true },
          };
        }

        const results = await searchProvider.search(params.query, max);
        const items = results.map((r, i) => ({ ...r, id: `web_${i + 1}` }));
        cache.set(cacheKey, results);

        return {
          content: [{ type: "text" as const, text: formatSearchResults(items, "web") }],
          details: { results: items },
        };
      } catch (err: any) {
        const accessError = webSearchAccessErrorResult(err);
        if (accessError) return accessError;
        return {
          content: [{ type: "text" as const, text: `Search error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── web_fetch tool ───────────────────────────────────────────────

const MAX_FETCH_CHARS = 8000;

const webFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch and extract clean content from" }),
});

export function createWebFetchTool(
  ctx: ToolContext,
  provider?: WebFetchProvider,
): AgentTool<typeof webFetchParams> {
  const fetchProvider = provider ?? createTavilyProvider();

  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract clean text content (markdown). " +
      "Use after web_search to read full articles from promising results. " +
      `Content is truncated at ${MAX_FETCH_CHARS} characters. ` +
      "Always cite the source URL in your answer.",
    parameters: webFetchParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      try {
        await assertWebSearchEntitlement(ctx);
        const result = await fetchProvider.fetch(params.url);
        const truncated =
          result.text.length > MAX_FETCH_CHARS
            ? result.text.slice(0, MAX_FETCH_CHARS) +
              `\n\n[Content truncated at ${MAX_FETCH_CHARS} chars. Visit ${params.url} for full content.]`
            : result.text;

        const header = result.title
          ? `## ${result.title}\nSource: ${params.url}\n\n`
          : `Source: ${params.url}\n\n`;

        return {
          content: [{ type: "text" as const, text: header + truncated }],
          details: {
            url: result.url,
            title: result.title,
            length: result.text.length,
            truncated: result.text.length > MAX_FETCH_CHARS,
          },
        };
      } catch (err: any) {
        const accessError = webSearchAccessErrorResult(err);
        if (accessError) return accessError;
        return {
          content: [
            {
              type: "text" as const,
              text: `Fetch error for ${params.url}: ${err.message}`,
            },
          ],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── Convenience ──────────────────────────────────────────────────

export function createWebTools(
  ctx: ToolContext,
  searchProvider?: WebSearchProvider,
  fetchProvider?: WebFetchProvider,
): AgentTool<any>[] {
  return [createWebSearchTool(ctx, searchProvider), createWebFetchTool(ctx, fetchProvider)];
}
