import type { DbRequestContext } from "./context.js";

export type CommunityKind = "article" | "bug" | "feature_request" | "announcement";

export type CommunityFeedbackStatus = "open" | "fixed" | "closed" | "planned" | "shipped" | "declined";

export interface CommunityArticleRow {
  id: string;
  author_id: string;
  title: string;
  body: string;
  excerpt: string | null;
  section: string;
  tags: string[];
  status: string;
  kind?: CommunityKind;
  is_featured?: boolean;
  feedback_status?: CommunityFeedbackStatus | null;
  comments_enabled?: boolean;
  like_count: number;
  comment_count: number;
  bookmark_count: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommunityCommentRow {
  id: string;
  article_id: string;
  author_id: string;
  root_id: string | null;
  reply_to_user_id: string | null;
  body: string;
  like_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CommunityAuthorProfileRow {
  user_id: string;
  is_official: boolean;
  bio: string | null;
  article_count: number;
  follower_count: number;
  created_at: string;
  updated_at: string;
}

export async function listCommunityArticles(ctx: DbRequestContext, opts: {
    section?: string;
    tag?: string;
    authorId?: string;
    kind?: CommunityKind;
    following?: boolean;
    userId?: string;
    sort?: "latest" | "popular" | "ranked";
    search?: string;
    featured?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<CommunityArticleRow[]> {
    let followedAuthorIds: string[] | undefined;
    if (opts.following) {
      if (!opts.userId) return [];
      followedAuthorIds = await listCommunityFolloweeIds(ctx, opts.userId);
      if (followedAuthorIds.length === 0) return [];
    }

    const params = new URLSearchParams();
    params.set("status", "eq.published");
    if (opts.kind) params.set("kind", `eq.${opts.kind}`);
    if (opts.section) params.set("section", `eq.${opts.section}`);
    if (opts.tag) params.set("tags", `cs.{${opts.tag}}`);
    if (opts.featured) params.set("is_featured", "eq.true");
    // Strip PostgREST operator syntax characters, then escape ilike wildcards so
    // user input like "100%" or "a_b" matches literally. PostgREST maps the
    // escaped \* to SQL \% and \_ to \_ (literal underscore).
    const search = opts.search?.replace(/[(),{}]/g, " ").trim();
    if (search) {
      const escaped = search.replace(/[*%_]/g, (m) => `\\${m}`);
      params.set("or", `(title.ilike.*${escaped}*,tags.cs.{${search}})`);
    }
    if (followedAuthorIds) {
      params.set("author_id", `in.(${followedAuthorIds.join(",")})`);
    } else if (opts.authorId) {
      params.set("author_id", `eq.${opts.authorId}`);
    }
    const order = opts.sort === "ranked"
      ? "is_featured.desc,bookmark_count.desc,like_count.desc,comment_count.desc,published_at.desc,id.desc"
      : opts.sort === "popular"
        ? "like_count.desc,published_at.desc,id.desc"
        : "published_at.desc";
    params.set("order", order);
    params.set("limit", String(opts.limit ?? 20));
    if (opts.cursor) {
      if (opts.sort === "popular" && opts.cursor.startsWith("popular:")) {
        const match = opts.cursor.match(/^popular:(-?\d+):([^:]+):(.+)$/);
        const likeCount = match ? Number(match[1]) : Number.NaN;
        const publishedAt = match ? decodeURIComponent(match[2]) : "";
        const id = match?.[3] ?? "";
        if (Number.isFinite(likeCount) && publishedAt && id) {
          params.set("or", `(like_count.lt.${likeCount},and(like_count.eq.${likeCount},published_at.lt.${publishedAt}),and(like_count.eq.${likeCount},published_at.eq.${publishedAt},id.lt.${id}))`);
        }
      } else {
        params.set("published_at", `lt.${opts.cursor}`);
      }
    }
    // List views render summaries only (excerpt + counts); body is intentionally
    // omitted so paginated list responses do not pull every article's full text.
    params.set("select", "id,author_id,title,excerpt,section,tags,status,kind,is_featured,feedback_status,comments_enabled,like_count,comment_count,bookmark_count,published_at,created_at,updated_at");
    const url = `${ctx.pgUrl}/community_articles?${params}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List community articles failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function listCommunityFolloweeIds(ctx: DbRequestContext, userId: string): Promise<string[]> {
    const params = new URLSearchParams();
    params.set("follower_id", `eq.${userId}`);
    params.set("select", "followee_id");
    const url = `${ctx.pgUrl}/community_follows?${params}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List community followees failed [${res.status}]: ${await res.text()}`);
    const rows: { followee_id: string }[] = await res.json();
    return rows.map((row) => row.followee_id);
  }

export async function isCommunityAdmin(ctx: DbRequestContext, userId: string): Promise<boolean> {
    const url = `${ctx.pgUrl}/community_user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.community_admin&select=role&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Check community admin failed [${res.status}]: ${await res.text()}`);
    const rows: { role: string }[] = await res.json();
    return rows.length > 0;
  }

export async function getCommunityArticle(ctx: DbRequestContext, id: string): Promise<CommunityArticleRow | null> {
    const url = `${ctx.pgUrl}/community_articles?id=eq.${encodeURIComponent(id)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get community article failed [${res.status}]: ${await res.text()}`);
    const rows: CommunityArticleRow[] = await res.json();
    return rows[0] ?? null;
  }

export async function listCommunityComments(ctx: DbRequestContext, articleId: string, opts?: { cursor?: string; limit?: number }): Promise<CommunityCommentRow[]> {
    const params = new URLSearchParams();
    params.set("article_id", `eq.${articleId}`);
    params.set("status", "eq.visible");
    params.set("order", "root_id.asc,created_at.asc");
    params.set("limit", String(opts?.limit ?? 100));
    const url = `${ctx.pgUrl}/community_comments?${params}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List community comments failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function getCommunityComment(ctx: DbRequestContext, id: string): Promise<CommunityCommentRow | null> {
    const url = `${ctx.pgUrl}/community_comments?id=eq.${encodeURIComponent(id)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get community comment failed [${res.status}]: ${await res.text()}`);
    const rows: CommunityCommentRow[] = await res.json();
    return rows[0] ?? null;
  }

export async function getCommunityAuthorProfile(ctx: DbRequestContext, userId: string): Promise<CommunityAuthorProfileRow | null> {
    const url = `${ctx.pgUrl}/community_author_profiles?user_id=eq.${encodeURIComponent(userId)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get community author profile failed [${res.status}]: ${await res.text()}`);
    const rows: CommunityAuthorProfileRow[] = await res.json();
    return rows[0] ?? null;
  }

export async function listCommunityArticlesByAuthor(ctx: DbRequestContext, userId: string, opts?: { cursor?: string; limit?: number }): Promise<CommunityArticleRow[]> {
    const params = new URLSearchParams();
    params.set("author_id", `eq.${userId}`);
    params.set("status", "eq.published");
    params.set("order", "published_at.desc");
    params.set("limit", String(opts?.limit ?? 20));
    if (opts?.cursor) params.set("published_at", `lt.${opts.cursor}`);
    params.set("select", "id,author_id,title,excerpt,section,tags,status,like_count,comment_count,bookmark_count,published_at,created_at,updated_at");
    const url = `${ctx.pgUrl}/community_articles?${params}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List community articles by author failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function listCommunityFeedbackByAuthor(ctx: DbRequestContext, userId: string): Promise<CommunityArticleRow[]> {
    const params = new URLSearchParams();
    params.set("author_id", `eq.${userId}`);
    params.set("kind", "in.(bug,feature_request)");
    params.set("status", "neq.deleted");
    params.set("order", "updated_at.desc");
    params.set("limit", "100");
    params.set("select", "id,author_id,title,body,excerpt,section,tags,status,kind,is_featured,feedback_status,comments_enabled,like_count,comment_count,bookmark_count,published_at,created_at,updated_at");
    const res = await fetch(`${ctx.pgUrl}/community_articles?${params}`, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List community feedback failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function createCommunityArticle(ctx: DbRequestContext, input: {
    authorId: string;
    title: string;
    body: string;
    excerpt?: string;
    section: string;
    tags?: string[];
    kind?: CommunityKind;
    feedbackStatus?: CommunityFeedbackStatus | null;
    commentsEnabled?: boolean;
  }): Promise<CommunityArticleRow> {
    const res = await fetch(`${ctx.pgUrl}/community_articles`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        author_id: input.authorId,
        title: input.title,
        body: input.body,
        excerpt: input.excerpt ?? null,
        section: input.section,
        tags: input.tags ?? [],
        kind: input.kind ?? "article",
        feedback_status: input.feedbackStatus ?? null,
        comments_enabled: input.commentsEnabled ?? true,
      }),
    });
    if (!res.ok) throw new Error(`Create community article failed [${res.status}]: ${await res.text()}`);
    const rows: CommunityArticleRow[] = await res.json();
    return rows[0];
  }

export async function updateCommunityArticle(ctx: DbRequestContext, id: string, input: {
    title?: string;
    body?: string;
    excerpt?: string;
    section?: string;
    tags?: string[];
  }): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.body !== undefined) patch.body = input.body;
    if (input.excerpt !== undefined) patch.excerpt = input.excerpt;
    if (input.section !== undefined) patch.section = input.section;
    if (input.tags !== undefined) patch.tags = input.tags;
    const res = await fetch(`${ctx.pgUrl}/community_articles?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Update community article failed [${res.status}]: ${await res.text()}`);
  }

export async function publishCommunityArticle(ctx: DbRequestContext, id: string): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/community_articles?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({ status: "published", published_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Publish community article failed [${res.status}]: ${await res.text()}`);
  }

export async function softDeleteCommunityArticle(ctx: DbRequestContext, id: string): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/community_articles?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({ status: "deleted" }),
    });
    if (!res.ok) throw new Error(`Soft-delete community article failed [${res.status}]: ${await res.text()}`);
  }

export async function setCommunityArticleFeatured(ctx: DbRequestContext, id: string, featured: boolean): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/community_articles?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({ is_featured: featured }),
    });
    if (!res.ok) throw new Error(`Set community featured failed [${res.status}]: ${await res.text()}`);
  }

export async function hideCommunityArticle(ctx: DbRequestContext, id: string): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/community_articles?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({ status: "hidden" }),
    });
    if (!res.ok) throw new Error(`Hide community article failed [${res.status}]: ${await res.text()}`);
  }

export async function updateCommunityFeedbackStatus(ctx: DbRequestContext, id: string, feedbackStatus: CommunityFeedbackStatus): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/community_articles?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({ feedback_status: feedbackStatus }),
    });
    if (!res.ok) throw new Error(`Update community feedback status failed [${res.status}]: ${await res.text()}`);
  }

export async function createCommunityComment(ctx: DbRequestContext, input: {
    articleId: string;
    authorId: string;
    body: string;
    rootId?: string;
    replyToUserId?: string;
  }): Promise<CommunityCommentRow> {
    const res = await fetch(`${ctx.pgUrl}/community_comments`, {
      method: "POST",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        article_id: input.articleId,
        author_id: input.authorId,
        body: input.body,
        root_id: input.rootId ?? null,
        reply_to_user_id: input.replyToUserId ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Create community comment failed [${res.status}]: ${await res.text()}`);
    const rows: CommunityCommentRow[] = await res.json();
    return rows[0];
  }

export async function softDeleteCommunityComment(ctx: DbRequestContext, id: string): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/community_comments?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: ctx.headers(),
      body: JSON.stringify({ status: "deleted" }),
    });
    if (!res.ok) throw new Error(`Soft-delete community comment failed [${res.status}]: ${await res.text()}`);
  }

export async function toggleCommunityArticleLike(ctx: DbRequestContext, articleId: string, userId: string, on: boolean): Promise<void> {
    if (on) {
      const res = await fetch(`${ctx.pgUrl}/community_article_likes`, {
        method: "POST",
        headers: ctx.headers({ Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify({ article_id: articleId, user_id: userId }),
      });
      if (!res.ok) throw new Error(`Like community article failed [${res.status}]: ${await res.text()}`);
    } else {
      const res = await fetch(`${ctx.pgUrl}/community_article_likes?article_id=eq.${encodeURIComponent(articleId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: ctx.headers(),
      });
      if (!res.ok && res.status !== 404) throw new Error(`Unlike community article failed [${res.status}]: ${await res.text()}`);
    }
  }

export async function toggleCommunityBookmark(ctx: DbRequestContext, articleId: string, userId: string, on: boolean): Promise<void> {
    if (on) {
      const res = await fetch(`${ctx.pgUrl}/community_bookmarks`, {
        method: "POST",
        headers: ctx.headers({ Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify({ article_id: articleId, user_id: userId }),
      });
      if (!res.ok) throw new Error(`Bookmark community article failed [${res.status}]: ${await res.text()}`);
    } else {
      const res = await fetch(`${ctx.pgUrl}/community_bookmarks?article_id=eq.${encodeURIComponent(articleId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: ctx.headers(),
      });
      if (!res.ok && res.status !== 404) throw new Error(`Remove bookmark failed [${res.status}]: ${await res.text()}`);
    }
  }

export async function toggleCommunityCommentLike(ctx: DbRequestContext, commentId: string, userId: string, on: boolean): Promise<void> {
    if (on) {
      const res = await fetch(`${ctx.pgUrl}/community_comment_likes`, {
        method: "POST",
        headers: ctx.headers({ Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify({ comment_id: commentId, user_id: userId }),
      });
      if (!res.ok) throw new Error(`Like community comment failed [${res.status}]: ${await res.text()}`);
    } else {
      const res = await fetch(`${ctx.pgUrl}/community_comment_likes?comment_id=eq.${encodeURIComponent(commentId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: ctx.headers(),
      });
      if (!res.ok && res.status !== 404) throw new Error(`Unlike community comment failed [${res.status}]: ${await res.text()}`);
    }
  }

export async function toggleCommunityFollow(ctx: DbRequestContext, followerId: string, followeeId: string, on: boolean): Promise<void> {
    if (on) {
      const res = await fetch(`${ctx.pgUrl}/community_follows`, {
        method: "POST",
        headers: ctx.headers({ Prefer: "resolution=merge-duplicates" }),
        body: JSON.stringify({ follower_id: followerId, followee_id: followeeId }),
      });
      if (!res.ok) throw new Error(`Follow failed [${res.status}]: ${await res.text()}`);
    } else {
      const res = await fetch(`${ctx.pgUrl}/community_follows?follower_id=eq.${encodeURIComponent(followerId)}&followee_id=eq.${encodeURIComponent(followeeId)}`, {
        method: "DELETE",
        headers: ctx.headers(),
      });
      if (!res.ok && res.status !== 404) throw new Error(`Unfollow failed [${res.status}]: ${await res.text()}`);
    }
  }

export async function getCommunityInteractions(ctx: DbRequestContext, userId: string, articleIds: string[]): Promise<Record<string, { liked: boolean; bookmarked: boolean }>> {
    const result: Record<string, { liked: boolean; bookmarked: boolean }> = {};
    for (const id of articleIds) result[id] = { liked: false, bookmarked: false };
    if (articleIds.length === 0) return result;

    const idFilter = `in.(${articleIds.map(encodeURIComponent).join(",")})`;

    const likesRes = await fetch(`${ctx.pgUrl}/community_article_likes?user_id=eq.${encodeURIComponent(userId)}&article_id=${idFilter}`, {
      headers: ctx.headers(),
    });
    if (likesRes.ok) {
      const liked: { article_id: string }[] = await likesRes.json();
      for (const row of liked) if (result[row.article_id]) result[row.article_id].liked = true;
    }

    const bmRes = await fetch(`${ctx.pgUrl}/community_bookmarks?user_id=eq.${encodeURIComponent(userId)}&article_id=${idFilter}`, {
      headers: ctx.headers(),
    });
    if (bmRes.ok) {
      const bookmarked: { article_id: string }[] = await bmRes.json();
      for (const row of bookmarked) if (result[row.article_id]) result[row.article_id].bookmarked = true;
    }

    return result;
  }

export async function isFollowing(ctx: DbRequestContext, followerId: string, followeeId: string): Promise<boolean> {
    const url = `${ctx.pgUrl}/community_follows?follower_id=eq.${encodeURIComponent(followerId)}&followee_id=eq.${encodeURIComponent(followeeId)}&select=follower_id&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) return false;
    const rows: unknown[] = await res.json();
    return rows.length > 0;
  }
