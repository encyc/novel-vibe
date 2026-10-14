import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createWebTools,
  createWebSearchTool,
  createWebFetchTool,
  type WebSearchProvider,
  type WebFetchProvider,
  type WebSearchResultItem,
} from "./web-tools.js";
import type { ToolContext } from "./file-tools.js";

/** Membership is now injected as a port; `has` answers the entitlement question. */
function mockEntitlements(has: (userId: string, entitlement: string) => Promise<boolean>) {
  return { has: vi.fn(has) } as unknown as ToolContext["entitlements"];
}

function mockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    storage: {
      read: vi.fn(),
      write: vi.fn(),
      search: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    } as any,
    skillsStorage: {
      read: vi.fn(),
    } as any,
    db: {
      listDocuments: vi.fn(),
    } as any,
    projectId: "test-project-id",
    userId: "test-user-id",
    assertProjectWritable: vi.fn().mockResolvedValue(undefined),
    // Default matches the previous "active membership with web_search" mock.
    entitlements: mockEntitlements(async () => true),
    ...overrides,
  };
}

function mockSearchProvider(
  results: WebSearchResultItem[] = [],
): WebSearchProvider {
  return {
    search: vi.fn().mockResolvedValue(results),
  };
}

function mockFetchProvider(
  result: { title?: string; text: string; url: string },
): WebFetchProvider {
  return {
    fetch: vi.fn().mockResolvedValue(result),
  };
}

function mockProvider(results?: WebSearchResultItem[]): WebSearchProvider {
  return mockSearchProvider(
    results ?? [
      { title: "Test Result 1", url: "https://example.com/1", snippet: "Snippet one." },
      { title: "Test Result 2", url: "https://example.com/2", snippet: "Snippet two." },
    ],
  );
}

describe("web-tools", () => {
  describe("createWebSearchTool", () => {
    it("has correct metadata", () => {
      const tool = createWebSearchTool(mockContext(), mockProvider());
      expect(tool.name).toBe("web_search");
      expect(tool.label).toBe("Web Search");
      expect(tool.description).toContain("Search the public web");
      expect(tool.description).toContain("web_fetch");
      expect(tool.description).toContain("[web_N]");
    });

    it("formats search results with source IDs", async () => {
      const provider = mockProvider();
      const tool = createWebSearchTool(mockContext(), provider);

      const result = await tool.execute("call-1", { query: "test" }, undefined as any, undefined);

      const text = result.content[0].text;
      expect(text).toContain("[web_1]");
      expect(text).toContain("**Test Result 1**");
      expect(text).toContain("https://example.com/1");
      expect(text).toContain("Snippet one.");
      expect(text).toContain("[web_2]");
      expect(text).toContain("**Test Result 2**");
      expect(text).toContain("Found 2 result(s)");
      expect(provider.search).toHaveBeenCalledWith("test", 5);
    });

    it("respects maxResults parameter", async () => {
      const provider = mockProvider();
      const tool = createWebSearchTool(mockContext(), provider);

      await tool.execute("call-2", { query: "test", maxResults: 3 }, undefined as any, undefined);

      expect(provider.search).toHaveBeenCalledWith("test", 3);
    });

    it("clamps maxResults between 1 and 10", async () => {
      const provider = mockProvider();
      const tool = createWebSearchTool(mockContext(), provider);

      await tool.execute("call-3a", { query: "test", maxResults: 0 }, undefined as any, undefined);
      expect(provider.search).toHaveBeenCalledWith("test", 1);

      await tool.execute("call-3b", { query: "test", maxResults: 50 }, undefined as any, undefined);
      expect(provider.search).toHaveBeenCalledWith("test", 10);
    });

    it("defaults to 5 results when maxResults not provided", async () => {
      const provider = mockProvider();
      const tool = createWebSearchTool(mockContext(), provider);

      await tool.execute("call-4", { query: "test" }, undefined as any, undefined);

      expect(provider.search).toHaveBeenCalledWith("test", 5);
    });

    it("caches results and returns cached on second call", async () => {
      const provider = mockProvider();
      const tool = createWebSearchTool(mockContext(), provider);

      const r1 = await tool.execute("call-5", { query: "cache test" }, undefined as any, undefined);
      expect(r1.details.cached).toBeUndefined();

      const r2 = await tool.execute("call-6", { query: "cache test" }, undefined as any, undefined);
      expect(r2.details.cached).toBe(true);

      // Provider should only have been called once
      expect(provider.search).toHaveBeenCalledTimes(1);
    });

    it("different queries produce different cache keys", async () => {
      const provider = mockProvider();
      const tool = createWebSearchTool(mockContext(), provider);

      await tool.execute("call-7", { query: "query A" }, undefined as any, undefined);
      await tool.execute("call-8", { query: "query B" }, undefined as any, undefined);

      expect(provider.search).toHaveBeenCalledTimes(2);
    });

    it("shows 'No results found' for empty result set", async () => {
      const provider = mockSearchProvider([]);
      const tool = createWebSearchTool(mockContext(), provider);

      const result = await tool.execute("call-9", { query: "nothing" }, undefined as any, undefined);

      expect(result.content[0].text).toContain("No results found");
    });

    it("returns error when provider.search throws", async () => {
      const provider: WebSearchProvider = {
        search: vi.fn().mockRejectedValue(new Error("API key invalid")),
      };
      const tool = createWebSearchTool(mockContext(), provider);

      const result = await tool.execute("call-10", { query: "test" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Search error");
      expect(result.content[0].text).toContain("API key invalid");
    });

    it("rejects web_search without an active membership before calling the provider", async () => {
      const provider = mockProvider();
      const has = vi.fn().mockResolvedValue(false);
      const ctx = mockContext({
        entitlements: { has } as unknown as ToolContext["entitlements"],
      });
      const result = await createWebSearchTool(ctx, provider)
        .execute("call-member-1", { query: "test" }, undefined as any, undefined);

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        code: "MEMBERSHIP_REQUIRED",
        feature: "web_search",
      });
      expect(has).toHaveBeenCalledWith("test-user-id", "web_search");
      expect(provider.search).not.toHaveBeenCalled();
    });

    it("rejects web_search when the active membership lacks the entitlement", async () => {
      const provider = mockProvider();
      const ctx = mockContext({
        entitlements: mockEntitlements(async () => false),
      });
      const result = await createWebSearchTool(ctx, provider)
        .execute("call-member-2", { query: "test" }, undefined as any, undefined);

      expect(result.details.code).toBe("MEMBERSHIP_REQUIRED");
      expect(provider.search).not.toHaveBeenCalled();
    });

    it("rejects web_search when userId is missing", async () => {
      const provider = mockProvider();
      const result = await createWebSearchTool(mockContext({ userId: undefined }), provider)
        .execute("call-member-3", { query: "test" }, undefined as any, undefined);

      expect(result.details.code).toBe("MEMBERSHIP_REQUIRED");
      expect(provider.search).not.toHaveBeenCalled();
    });

    it("fails closed when membership authorization is unavailable", async () => {
      const provider = mockProvider();
      const ctx = mockContext({
        entitlements: mockEntitlements(async () => {
          throw new Error("database unavailable");
        }),
      });
      const result = await createWebSearchTool(ctx, provider)
        .execute("call-member-4", { query: "test" }, undefined as any, undefined);

      expect(result.details.code).toBe("WEB_SEARCH_AUTHORIZATION_UNAVAILABLE");
      expect(provider.search).not.toHaveBeenCalled();
    });

    it("authorizes before returning a cached web_search result", async () => {
      const has = vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const provider = mockProvider();
      const tool = createWebSearchTool(
        mockContext({ entitlements: { has } as unknown as ToolContext["entitlements"] }),
        provider,
      );

      await tool.execute("call-member-5a", { query: "cached" }, undefined as any, undefined);
      const denied = await tool.execute(
        "call-member-5b",
        { query: "cached" },
        undefined as any,
        undefined,
      );

      expect(denied.details.code).toBe("MEMBERSHIP_REQUIRED");
      expect(has).toHaveBeenCalledTimes(2);
      expect(provider.search).toHaveBeenCalledTimes(1);
    });
  });

  describe("createWebFetchTool", () => {
    it("has correct metadata", () => {
      const provider = mockFetchProvider({
        title: "A Page",
        text: "hello world",
        url: "https://example.com",
      });
      const tool = createWebFetchTool(mockContext(), provider);
      expect(tool.name).toBe("web_fetch");
      expect(tool.label).toBe("Web Fetch");
      expect(tool.description).toContain("Fetch a URL");
      expect(tool.description).toContain("web_search");
    });

    it("has sequential execution mode", () => {
      const provider = mockFetchProvider({
        title: "A Page",
        text: "hello",
        url: "https://example.com",
      });
      const tool = createWebFetchTool(mockContext(), provider);
      expect(tool.executionMode).toBe("sequential");
    });

    it("fetches and formats content with title", async () => {
      const provider = mockFetchProvider({
        title: "Article Title",
        text: "Full article content here.",
        url: "https://example.com/article",
      });
      const tool = createWebFetchTool(mockContext(), provider);

      const result = await tool.execute(
        "call-f1",
        { url: "https://example.com/article" },
        undefined as any,
        undefined,
      );

      const text = result.content[0].text;
      expect(text).toContain("## Article Title");
      expect(text).toContain("Source: https://example.com/article");
      expect(text).toContain("Full article content here.");
      expect(result.details.url).toBe("https://example.com/article");
      expect(result.details.title).toBe("Article Title");
      expect(result.details.truncated).toBe(false);
      expect(provider.fetch).toHaveBeenCalledWith("https://example.com/article");
    });

    it("works without title", async () => {
      const provider = mockFetchProvider({
        text: "Content without title.",
        url: "https://example.com/no-title",
      });
      const tool = createWebFetchTool(mockContext(), provider);

      const result = await tool.execute(
        "call-f2",
        { url: "https://example.com/no-title" },
        undefined as any,
        undefined,
      );

      expect(result.content[0].text).toContain("Source: https://example.com/no-title");
      expect(result.content[0].text).toContain("Content without title.");
      expect(result.details.title).toBeUndefined();
    });

    it("truncates content exceeding MAX_FETCH_CHARS", async () => {
      const longText = "x".repeat(9000);
      const provider = mockFetchProvider({
        title: "Long Page",
        text: longText,
        url: "https://example.com/long",
      });
      const tool = createWebFetchTool(mockContext(), provider);

      const result = await tool.execute(
        "call-f3",
        { url: "https://example.com/long" },
        undefined as any,
        undefined,
      );

      expect(result.content[0].text).toContain("[Content truncated at 8000 chars");
      expect(result.content[0].text.length).toBeLessThan(longText.length + 200);
      expect(result.details.truncated).toBe(true);
      expect(result.details.length).toBe(9000);
    });

    it("returns error when provider.fetch throws", async () => {
      const provider: WebFetchProvider = {
        fetch: vi.fn().mockRejectedValue(new Error("Connection refused")),
      };
      const tool = createWebFetchTool(mockContext(), provider);

      const result = await tool.execute(
        "call-f4",
        { url: "https://example.com/dead" },
        undefined as any,
        undefined,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Fetch error");
      expect(result.content[0].text).toContain("Connection refused");
      expect(result.content[0].text).toContain("https://example.com/dead");
    });

    it("rejects web_fetch without the entitlement before calling the provider", async () => {
      const provider = mockFetchProvider({
        text: "x",
        url: "https://example.com",
      });
      const ctx = mockContext({
        entitlements: mockEntitlements(async () => false),
      });
      const result = await createWebFetchTool(ctx, provider)
        .execute("call-member-6", { url: "https://example.com" }, undefined as any, undefined);

      expect(result.details.code).toBe("MEMBERSHIP_REQUIRED");
      expect(provider.fetch).not.toHaveBeenCalled();
    });
  });

  describe("createWebTools", () => {
    it("returns both web_search and web_fetch tools", () => {
      const searchProvider = mockSearchProvider([]);
      const fetchProvider = mockFetchProvider({
        text: "x",
        url: "https://a.com",
      });
      const tools = createWebTools(mockContext(), searchProvider, fetchProvider);
      expect(tools).toHaveLength(2);

      const names = tools.map((t) => t.name);
      expect(names).toContain("web_search");
      expect(names).toContain("web_fetch");
    });

    it("accepts optional provider overrides", () => {
      const searchProvider = mockSearchProvider([]);
      const fetchProvider = mockFetchProvider({
        text: "x",
        url: "https://a.com",
      });
      const tools = createWebTools(mockContext(), searchProvider, fetchProvider);

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("web_search");
      expect(tools[1].name).toBe("web_fetch");
    });
  });
});
