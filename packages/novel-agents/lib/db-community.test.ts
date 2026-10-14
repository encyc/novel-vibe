import { afterEach, describe, expect, it, vi } from "vitest";
import { DbClient } from "./db.js";

// DbClient methods are thin fetch wrappers over PostgREST.
// We mock global fetch and assert the correct URL, method, headers, and body are sent.

function makeClient() {
  return DbClient.forUser("test-token");
}

afterEach(() => vi.unstubAllGlobals());

describe("DbClient community reads", () => {
  it("listCommunityArticles builds filtered query with sort and cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "a1", title: "T1" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    const rows = await db.listCommunityArticles({
      section: "prompt",
      sort: "popular",
      cursor: "cur123",
      limit: 10,
    });

    expect(rows).toEqual([{ id: "a1", title: "T1" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("/community_articles?");
    expect(url as string).toContain("section=eq.prompt");
    expect(url as string).toContain("order=like_count.desc");
    expect(url as string).toContain("limit=10");
    expect((init as RequestInit).headers as Record<string, string>).toHaveProperty("Authorization", "Bearer test-token");
  });

  it("listCommunityArticles uses a composite cursor for popular pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.listCommunityArticles({
      sort: "popular",
      cursor: "popular:10:2026-07-01T00%3A00%3A00.000Z:a1",
      limit: 10,
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("order=like_count.desc%2Cpublished_at.desc%2Cid.desc");
    expect(url).toContain("or=");
    expect(url).not.toContain("published_at=lt.");
  });

  it("listCommunityArticles uses following filter when provided", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { followee_id: "author-1" },
        { followee_id: "author-2" },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.listCommunityArticles({ following: true, userId: "u1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const followUrl = fetchMock.mock.calls[0][0] as string;
    expect(followUrl).toContain("/community_follows?");
    expect(followUrl).toContain("follower_id=eq.u1");
    const articleUrl = fetchMock.mock.calls[1][0] as string;
    expect(articleUrl).toContain("author_id=in.%28author-1%2Cauthor-2%29");
    expect(articleUrl).not.toContain("select%20followee_id");
  });

  it("listCommunityArticles returns an empty following feed without querying articles when no followees exist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await expect(db.listCommunityArticles({ following: true, userId: "u1" })).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getCommunityArticle fetches by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "a1", title: "T1", body: "B1" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    const row = await db.getCommunityArticle("a1");

    expect(row).toEqual({ id: "a1", title: "T1", body: "B1" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/community_articles?id=eq.a1");
  });

  it("getCommunityArticle returns null when not found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    ));
    const db = makeClient();
    expect(await db.getCommunityArticle("missing")).toBeNull();
  });

  it("getCommunityComment fetches a comment by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "c1", article_id: "a1" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    const row = await db.getCommunityComment("c1");

    expect(row).toEqual({ id: "c1", article_id: "a1" });
    expect(fetchMock.mock.calls[0][0] as string).toContain("/community_comments?id=eq.c1");
  });

  it("listCommunityComments fetches visible comments for an article ordered by root+time", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "c1" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    const rows = await db.listCommunityComments("a1");

    expect(rows).toEqual([{ id: "c1" }]);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("article_id=eq.a1");
    expect(url).toContain("order=root_id.asc");
  });
});

describe("DbClient community writes", () => {
  it("createCommunityArticle posts with return=representation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "a1", status: "draft" }]), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    const row = await db.createCommunityArticle({
      authorId: "u1",
      title: "My Article",
      body: "Content",
      section: "prompt",
      tags: ["ai-writing"],
      kind: "bug",
      feedbackStatus: "open",
      commentsEnabled: true,
    });

    expect(row).toEqual({ id: "a1", status: "draft" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("/community_articles");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers as Record<string, string>).toHaveProperty("Prefer", "return=representation");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.author_id).toBe("u1");
    expect(body.title).toBe("My Article");
    expect(body.section).toBe("prompt");
    expect(body.tags).toEqual(["ai-writing"]);
    expect(body.kind).toBe("bug");
    expect(body.feedback_status).toBe("open");
    expect(body.comments_enabled).toBe(true);
  });

  it("publishCommunityArticle sets status and published_at", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "a1", status: "published" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.publishCommunityArticle("a1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("id=eq.a1");
    expect((init as RequestInit).method).toBe("PATCH");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.status).toBe("published");
    expect(body.published_at).toBeDefined();
  });

  it("softDeleteCommunityArticle sets status to deleted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.softDeleteCommunityArticle("a1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("id=eq.a1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string).status).toBe("deleted");
  });

  it("toggleCommunityArticleLike inserts when on=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.toggleCommunityArticleLike("a1", "u1", true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("/community_article_likes");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.article_id).toBe("a1");
    expect(body.user_id).toBe("u1");
  });

  it("toggleCommunityArticleLike deletes when on=false (idempotent)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.toggleCommunityArticleLike("a1", "u1", false);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url as string).toContain("article_id=eq.a1");
    expect(url as string).toContain("user_id=eq.u1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("getCommunityInteractions returns a map of article states", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ article_id: "a1" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ article_id: "a2" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    const result = await db.getCommunityInteractions("u1", ["a1", "a2"]);

    expect(result).toEqual({
      a1: { liked: true, bookmarked: false },
      a2: { liked: false, bookmarked: true },
    });
  });
});

describe("DbClient.forAnon", () => {
  it("creates a client that does not send an Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = DbClient.forAnon();
    await db.listCommunityArticles({});

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).toHaveProperty("Accept-Profile", "novel");
  });
});

describe("DbClient minimum operable community", () => {
  it("listCommunityArticles sends kind, ranked sort, search, and featured filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.listCommunityArticles({
      kind: "article",
      sort: "ranked",
      search: "大纲",
      featured: true,
      tag: "灵器入门",
      limit: 20,
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("kind=eq.article");
    expect(url).toContain("is_featured=eq.true");
    expect(url).toContain("tags=cs.%7B%E7%81%B5%E5%99%A8%E5%85%A5%E9%97%A8%7D");
    const decodedUrl = decodeURIComponent(url);
    expect(decodedUrl).toContain("or=(title.ilike.*大纲*,tags.cs.{大纲})");
    expect(url).toContain("order=");
  });

  it("listCommunityArticles escapes ilike wildcards in search so they match literally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.listCommunityArticles({ search: "100% off_a*" });

    const decodedUrl = decodeURIComponent(fetchMock.mock.calls[0][0] as string);
    // ilike operand escapes %, _, * with a backslash; tags.cs uses the raw value.
    // URLSearchParams encodes spaces as "+", which survive decodeURIComponent.
    expect(decodedUrl).toContain("title.ilike.*100\\%+off\\_a\\**");
    expect(decodedUrl).toContain("tags.cs.{100%+off_a*}");
  });

  it("checks whether a user is a community admin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ role: "community_admin" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await expect(db.isCommunityAdmin("u1")).resolves.toBe(true);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/community_user_roles?");
    expect(url).toContain("user_id=eq.u1");
    expect(url).toContain("role=eq.community_admin");
  });

  it("updates featured and feedback status through patch calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.setCommunityArticleFeatured("a1", true);
    await db.updateCommunityFeedbackStatus("a1", "planned");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ is_featured: true });
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ feedback_status: "planned" });
  });

  it("lists my feedback by author and feedback kinds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: "b1" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const db = makeClient();
    await db.listCommunityFeedbackByAuthor("u1");

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("author_id=eq.u1");
    expect(url).toContain("kind=in.%28bug%2Cfeature_request%29");
    expect(url).toContain("order=updated_at.desc");
    expect(url).toContain("limit=100");
  });
});
