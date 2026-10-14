import { jsonResponse } from "../http.js";
import { notifyIndexNow } from "../../lib/indexnow.js";
import { parseBody } from "../http.js";
import { resolve, dirname } from "node:path";
import { submitBaiduUrls } from "../../lib/baidu-submit.js";

import type { RouteContext } from "../http.js";

import { createLogger } from "../../lib/logger.js";

import { CommunityService, CommunityServiceError } from "../../community/service.js";
import { DbClient } from "../../lib/db.js";
import { errorResponse } from "../http.js";
const log = createLogger("server");

const COMMUNITY_SECTIONS = [
  { value: "prompt", label: "提示词技巧" },
  { value: "worldbuilding", label: "世界观构建" },
  { value: "character", label: "角色设计" },
  { value: "outline", label: "大纲与结构" },
  { value: "chapter", label: "章节写作" },
  { value: "tools", label: "工具分享" },
  { value: "showcase", label: "作品展示" },
  { value: "announcements", label: "官方公告" },
];

function notifyCommunityUrl(articleId: string, removed = false): void {
  const urls = [`https://lingqiai.art/community/${encodeURIComponent(articleId)}`];
  void Promise.all([
    notifyIndexNow(urls),
    removed
      ? Promise.resolve({ status: "skipped" as const })
      : submitBaiduUrls(urls),
  ]).then(([indexNowResult, baiduResult]) => {
    if (indexNowResult.status === "failed") {
      log.warn("IndexNow notification failed", {
        httpStatus: indexNowResult.httpStatus,
        urlCount: indexNowResult.urlCount,
      });
    }
    if (baiduResult.status === "failed") {
      log.warn("Baidu URL submission failed", {
        httpStatus: baiduResult.httpStatus,
        urlCount: baiduResult.urlCount,
      });
    }
  });
}

function isIndexableCommunityArticle(article: { status: string; kind: string }): boolean {
  return article.status === "published"
    && (article.kind === "article" || article.kind === "announcement");
}

export async function communitySectionsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  jsonResponse(res, { sections: COMMUNITY_SECTIONS });
  return;

}

export async function communityArticlesGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const sp = url.searchParams;
  const result = await communityService().listArticles({
    kind: sp.get("kind") as any ?? undefined,
    section: sp.get("section") ?? undefined,
    tag: sp.get("tag") ?? undefined,
    authorId: sp.get("author_id") ?? undefined,
    sort: sp.get("sort") === "popular" ? "popular" : sp.get("sort") === "ranked" ? "ranked" : "latest",
    search: sp.get("search") ?? undefined,
    featured: sp.get("featured") === "true",
    cursor: sp.get("cursor") ?? undefined,
    limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined,
  });
  jsonResponse(res, result);
  return;

}

export async function communityArticlesFollowingGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const sp = url.searchParams;
  const result = await communityService().listArticles({
    following: true,
    userId,
    sort: sp.get("sort") === "popular" ? "popular" : "latest",
    cursor: sp.get("cursor") ?? undefined,
    limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined,
  });
  jsonResponse(res, result);
  return;

}

export async function communityArticlesPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  const article = await communityService().createArticle(userId, {
    kind: body.kind ? String(body.kind) as any : undefined,
    title: String(body.title ?? ""),
    body: String(body.body ?? ""),
    excerpt: body.excerpt ? String(body.excerpt) : undefined,
    section: body.section ? String(body.section) : undefined,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
  });
  jsonResponse(res, { article }, 201);
  return;

}

export async function communityArticleGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const article = await communityService().getArticle(decodeURIComponent(params[1]));
  jsonResponse(res, { article });
  return;

}

export async function communityArticlePatch({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const articleId = decodeURIComponent(params[1]);
  const service = communityService();
  const body = JSON.parse(await parseBody(req));
  await service.updateArticle(userId, articleId, {
    title: body.title, body: body.body, excerpt: body.excerpt, section: body.section, tags: body.tags,
  });
  const article = await service.getArticle(articleId);
  if (isIndexableCommunityArticle(article)) notifyCommunityUrl(articleId);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityArticleDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const articleId = decodeURIComponent(params[1]);
  const service = communityService();
  const article = await service.getArticle(articleId);
  await service.deleteArticle(userId, articleId);
  if (isIndexableCommunityArticle(article)) notifyCommunityUrl(articleId, true);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityPublishPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const articleId = decodeURIComponent(params[1]);
  const service = communityService();
  await service.publishArticle(userId, articleId);
  const article = await service.getArticle(articleId);
  if (isIndexableCommunityArticle(article)) notifyCommunityUrl(articleId);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityFeaturePost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().setFeatured(userId, decodeURIComponent(params[1]), true);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityFeatureDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().setFeatured(userId, decodeURIComponent(params[1]), false);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityHidePost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const articleId = decodeURIComponent(params[1]);
  const service = communityService();
  const article = await service.getArticle(articleId);
  await service.hideArticle(userId, articleId);
  if (isIndexableCommunityArticle(article)) notifyCommunityUrl(articleId, true);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityFeedbackStatusPatch({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  await communityService().updateFeedbackStatus(
    userId,
    decodeURIComponent(params[1]),
    String(body.feedbackStatus) as any,
  );
  jsonResponse(res, { ok: true });
  return;

}

export async function communityLikePost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().toggleLike(userId, decodeURIComponent(params[1]), true);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityLikeDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().toggleLike(userId, decodeURIComponent(params[1]), false);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityBookmarkPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().toggleBookmark(userId, decodeURIComponent(params[1]), true);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityBookmarkDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().toggleBookmark(userId, decodeURIComponent(params[1]), false);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityCommentGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const comments = await communityService().listComments(decodeURIComponent(params[1]));
  jsonResponse(res, { comments });
  return;

}

export async function communityCommentPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const body = JSON.parse(await parseBody(req));
  const comment = await communityService().createComment(userId, {
    articleId: decodeURIComponent(params[1]),
    body: String(body.body ?? ""),
    rootId: body.rootId,
    replyToUserId: body.replyToUserId,
  });
  jsonResponse(res, { comment }, 201);
  return;

}

export async function communityCommentLikePost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().toggleCommentLike(userId, decodeURIComponent(params[1]), true);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityCommentLikeDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().toggleCommentLike(userId, decodeURIComponent(params[1]), false);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityCommentDeleteDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().deleteComment(userId, decodeURIComponent(params[1]));
  jsonResponse(res, { ok: true });
  return;

}

export async function communityAuthorProfileGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const profile = await communityService().getAuthorProfile(decodeURIComponent(params[1]));
  jsonResponse(res, { profile });
  return;

}

export async function communityFollowingStateGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const following = await communityService().getFollowingState(userId, decodeURIComponent(params[1]));
  jsonResponse(res, { following });
  return;

}

export async function communityAuthorArticlesGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const sp = url.searchParams;
  const result = await communityService().listArticlesByAuthor(
    decodeURIComponent(params[1]),
    { cursor: sp.get("cursor") ?? undefined, limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined },
  );
  jsonResponse(res, result);
  return;

}

export async function communityFollowPost({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().toggleFollow(userId, decodeURIComponent(params[1]), true);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityFollowDelete({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  await communityService().toggleFollow(userId, decodeURIComponent(params[1]), false);
  jsonResponse(res, { ok: true });
  return;

}

export async function communityMeInteractionsGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
  const interactions = await communityService().getInteractions(userId, ids);
  jsonResponse(res, { interactions });
  return;

}

export async function communityMeFeedbackGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  jsonResponse(res, await communityService().listMyFeedback(userId));
  return;

}

export async function communityMeAdminGet({ req, res, url, path, token, identity, userId, email, params, profileService, paymentService, membershipService, communityService }: RouteContext) {
  jsonResponse(res, { isCommunityAdmin: await communityService().isAdmin(userId) });
  return;

}


export async function handleCommunityAnonReads(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL, path: string): Promise<boolean> {
  if (!(
    req.method === "GET" && path.startsWith("/api/community/")
        && path !== "/api/community/me/interactions"
        && path !== "/api/community/me/feedback"
        && path !== "/api/community/me/admin"
        && path !== "/api/community/articles/following"
        && !/^\/api\/community\/users\/[^/]+\/following-state$/.test(path)
  )) {
    return false;
  }
  try {
    const anonDb = DbClient.forAnon();
    const anonService = new CommunityService(anonDb);

    if (path === "/api/community/sections") {
      jsonResponse(res, { sections: COMMUNITY_SECTIONS });
      return true;
    }

    if (path === "/api/community/articles") {
      const sp = url.searchParams;
      const result = await anonService.listArticles({
        kind: sp.get("kind") as any ?? undefined,
        section: sp.get("section") ?? undefined,
        tag: sp.get("tag") ?? undefined,
        authorId: sp.get("author_id") ?? undefined,
        sort: sp.get("sort") === "popular" ? "popular" : sp.get("sort") === "ranked" ? "ranked" : "latest",
        search: sp.get("search") ?? undefined,
        featured: sp.get("featured") === "true",
        cursor: sp.get("cursor") ?? undefined,
        limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined,
      });
      jsonResponse(res, result);
      return true;
    }

    const communityArticleMatch = path.match(/^\/api\/community\/articles\/([^/]+)$/);
    if (communityArticleMatch) {
      const article = await anonService.getArticle(decodeURIComponent(communityArticleMatch[1]));
      jsonResponse(res, { article });
      return true;
    }

    const communityCommentsMatch = path.match(/^\/api\/community\/articles\/([^/]+)\/comments$/);
    if (communityCommentsMatch) {
      const comments = await anonService.listComments(decodeURIComponent(communityCommentsMatch[1]));
      jsonResponse(res, { comments });
      return true;
    }

    const communityAuthorProfileMatch = path.match(/^\/api\/community\/users\/([^/]+)\/profile$/);
    if (communityAuthorProfileMatch) {
      const profile = await anonService.getAuthorProfile(decodeURIComponent(communityAuthorProfileMatch[1]));
      jsonResponse(res, { profile });
      return true;
    }

    const communityAuthorArticlesMatch = path.match(/^\/api\/community\/users\/([^/]+)\/articles$/);
    if (communityAuthorArticlesMatch) {
      const sp = url.searchParams;
      const result = await anonService.listArticlesByAuthor(
        decodeURIComponent(communityAuthorArticlesMatch[1]),
        { cursor: sp.get("cursor") ?? undefined, limit: sp.get("limit") ? parseInt(sp.get("limit")!, 10) : undefined },
      );
      jsonResponse(res, result);
      return true;
    }

    errorResponse(res, 404, "NOT_FOUND", "Not found");
  } catch (err: any) {
    if (err instanceof CommunityServiceError) {
      errorResponse(res, err.status, err.code, err.message);
      return true;
    }
    log.error("Community read error:", err);
    errorResponse(res, 500, "INTERNAL_ERROR");
  }
  return true;

  return true;
}