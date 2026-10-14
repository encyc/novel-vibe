import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AgentApi, AgentApiError } from "./agent-api.js";
import {
  isIndexableArticle,
  normalizeCommunitySeoLocale,
  renderCommunityArticleDocument,
  renderCommunityIndexDocument,
  renderRobotsTxt,
  renderSitemapXml,
  type CommunitySeoArticle,
} from "./community-seo.js";
import type { WebConfig } from "./config.js";
import { LOCAL_USER_EMAIL, LOCAL_USER_ID } from "./config.js";
import { authenticateWithInsForge, refreshInsForgeSession } from "./insforge-auth.js";
import {
  cookieFlags,
  errorResponse,
  hasAllowedBrowserOrigin,
  isStateChangingMethod,
  json,
  parseCookies,
  parseJsonBody,
  readBody,
  RequestBodyTooLargeError,
} from "./http.js";
import { SessionStore, type WebSession } from "./sessions.js";
import { normalizeUpstreamError } from "./upstream-error.js";

interface AuthBody {
  email?: string;
  password?: string;
  mode?: "login" | "signup";
  registrationTicket?: string;
  inviteCode?: string;
}

interface CommunityArticlePage {
  items: CommunitySeoArticle[];
  nextCursor: string | null;
}

function sendText(
  res: ServerResponse,
  body: string,
  contentType: string,
  status = 200,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "Content-Type": contentType, ...headers });
  res.end(body);
}

async function forwardUpstreamResponse(
  res: ServerResponse,
  upstream: Response,
  defaultContentType: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? defaultContentType;
  const text = await upstream.text();
  if (!upstream.ok) {
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = undefined;
    }
    if (payload !== undefined) {
      json(res, normalizeUpstreamError(payload), upstream.status, headers);
      return;
    }
  }
  sendText(res, text, contentType, upstream.status, headers);
}

async function readWebuiTemplate(config: WebConfig): Promise<string> {
  return readFile(join(config.webuiDistDir, "index.html"), "utf8");
}

async function fetchCommunityPage(
  config: WebConfig,
  kind: "article" | "announcement",
  cursor?: string,
): Promise<CommunityArticlePage> {
  const params = new URLSearchParams({ kind, sort: "latest", limit: "100" });
  if (cursor) params.set("cursor", cursor);
  const upstream = await fetch(`${config.agentServerUrl}/api/community/articles?${params}`);
  if (!upstream.ok) throw new Error(`Community list failed with ${upstream.status}`);
  return await upstream.json() as CommunityArticlePage;
}

async function fetchIndexableArticles(config: WebConfig, maxPages: number): Promise<CommunitySeoArticle[]> {
  const articles: CommunitySeoArticle[] = [];
  for (const kind of ["article", "announcement"] as const) {
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await fetchCommunityPage(config, kind, cursor);
      articles.push(...page.items.filter(isIndexableArticle));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }
  return articles;
}

const RESERVED_COMMUNITY_PATHS = new Set(["write", "edit", "author", "my-feedback"]);
const INTERFACE_LOCALE_COOKIE_NAME = "novel-vibe-locale";
const REFERRAL_DEVICE_COOKIE_NAME = "novel_referral_device";

function referralDeviceCookie(value: string, secure: boolean, domain?: string): string {
  return [
    `${REFERRAL_DEVICE_COOKIE_NAME}=${value}`,
    "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${60 * 60 * 24 * 400}`,
    secure ? "Secure" : "", domain ? `Domain=${domain}` : "",
  ].filter(Boolean).join("; ");
}

function communitySeoLocale(req: IncomingMessage) {
  const cookies = parseCookies(req.headers.cookie);
  return normalizeCommunitySeoLocale(
    req.headers["x-interface-locale"]
      ?? cookies[INTERFACE_LOCALE_COOKIE_NAME]
      ?? req.headers["accept-language"],
  );
}

function communitySeoCacheControl(req: IncomingMessage): string {
  return req.headers.cookie
    ? "private, max-age=60"
    : "public, max-age=60, stale-while-revalidate=300";
}

function withTrustedUser(pathAndSearch: string, userId: string): string {
  const upstream = new URL(pathAndSearch, "http://agent.local");
  upstream.searchParams.set("user_id", userId);
  return `${upstream.pathname}${upstream.search}`;
}

/**
 * Authorization header for an outbound agent-server request.
 *
 * Hosted mode holds a real InsForge token and must forward it (RLS depends on
 * it). Local mode holds none: omitting the header is what makes the agent
 * server mint the local identity instead of rejecting the request.
 */
function bearerHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Synthetic session standing in for the local-first identity.
 *
 * The route table below is built around `session`: "no session" means 401 and
 * "session" means stamp the trusted `user_id`. Local mode has no authorization
 * server but it does have an identity, so it supplies this fixed one. The empty
 * `accessToken` makes every outbound request go out without an Authorization
 * header, and `userId`/`email` are exactly the identity the agent server's local
 * issuer derives — so the trusted `user_id` the existing branches stamp onto
 * requests never contradicts what the agent server resolves.
 */
function localSession(): WebSession {
  return {
    id: "local-first",
    userId: LOCAL_USER_ID,
    email: LOCAL_USER_EMAIL,
    accessToken: "",
    refreshToken: "",
    accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

export function createHandler(config: WebConfig, store = new SessionStore(
  config.jwtSecret,
  config.sessionTtlSeconds,
  (refreshToken) => refreshInsForgeSession(config.insforgeUrl, refreshToken),
)) {
  const agent = new AgentApi(config.agentServerUrl);

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const secure = req.headers["x-forwarded-proto"] === "https";
      const isPublicRead = req.method === "GET" || req.method === "HEAD";

      if (url.pathname === "/health") {
        json(res, { status: "ok", service: "novel-web" });
        return;
      }

      // The WebUI's only source of truth for which profile it is talking to.
      // Answered by the BFF itself (never proxied): the mode is a BFF property.
      if (url.pathname === "/api/mode" && req.method === "GET") {
        json(res, { localMode: config.localMode });
        return;
      }

      if (isStateChangingMethod(req.method)
          && !hasAllowedBrowserOrigin(req.headers.origin, config.allowedOrigins)) {
        errorResponse(res, 403, "ORIGIN_NOT_ALLOWED", "Origin not allowed");
        return;
      }

      if (isPublicRead && url.pathname === "/robots.txt") {
        sendText(res, renderRobotsTxt(), "text/plain; charset=utf-8", 200, {
          "Cache-Control": "public, max-age=3600",
        });
        return;
      }

      if (isPublicRead && config.indexNowKey
          && url.pathname === `/${config.indexNowKey}.txt`) {
        sendText(res, config.indexNowKey, "text/plain; charset=utf-8", 200, {
          "Cache-Control": "public, max-age=86400, immutable",
          "X-Content-Type-Options": "nosniff",
        });
        return;
      }

      if (isPublicRead && url.pathname === "/sitemap.xml") {
        try {
          const articles = await fetchIndexableArticles(config, 10);
          const entries = [
            { loc: "https://lingqiai.art/" },
            { loc: "https://lingqiai.art/community" },
            ...articles.map((article) => ({
              loc: `https://lingqiai.art/community/${encodeURIComponent(article.id)}`,
              lastmod: article.updatedAt || article.publishedAt,
            })),
          ];
          sendText(res, renderSitemapXml(entries), "application/xml; charset=utf-8", 200, {
            "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
          });
        } catch {
          errorResponse(
            res,
            502,
            "SITEMAP_UPSTREAM_UNAVAILABLE",
            "The community sitemap is temporarily unavailable",
          );
        }
        return;
      }

      if (isPublicRead && url.pathname === "/community") {
        const seoLocale = communitySeoLocale(req);
        const [template, articles] = await Promise.all([
          readWebuiTemplate(config),
          fetchIndexableArticles(config, 1),
        ]);
        sendText(
          res,
          renderCommunityIndexDocument(template, articles, seoLocale),
          "text/html; charset=utf-8",
          200,
          { "Cache-Control": communitySeoCacheControl(req), Vary: "Cookie, X-Interface-Locale, Accept-Language" },
        );
        return;
      }

      const communityDocumentMatch = url.pathname.match(/^\/community\/([^/]+)$/);
      if (isPublicRead && communityDocumentMatch
          && !RESERVED_COMMUNITY_PATHS.has(communityDocumentMatch[1])) {
        const articleId = decodeURIComponent(communityDocumentMatch[1]);
        const seoLocale = communitySeoLocale(req);
        const upstream = await fetch(
          `${config.agentServerUrl}/api/community/articles/${encodeURIComponent(articleId)}`,
        );
        if (!upstream.ok) {
          await forwardUpstreamResponse(
            res,
            upstream,
            "application/json; charset=utf-8",
            { "X-Robots-Tag": "noindex, nofollow" },
          );
          return;
        }
        const payload = await upstream.json() as { article: CommunitySeoArticle };
        const template = await readWebuiTemplate(config);
        const indexable = isIndexableArticle(payload.article);
        sendText(
          res,
          renderCommunityArticleDocument(template, payload.article, seoLocale),
          "text/html; charset=utf-8",
          200,
          {
            "Cache-Control": communitySeoCacheControl(req),
            Vary: "Cookie, X-Interface-Locale, Accept-Language",
            ...(!indexable ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
          },
        );
        return;
      }

      // Local mode has no sign-in server: the browser is already the local user,
      // so report success without contacting InsForge. No cookie is issued —
      // every request is identified by the agent server's local issuer.
      if (config.localMode && url.pathname === "/api/auth" && req.method === "POST") {
        json(res, { ok: true });
        return;
      }

      if (url.pathname === "/api/auth" && req.method === "POST") {
        const body = await parseJsonBody<AuthBody>(req);
        if (!body.email || !body.password) {
          errorResponse(
            res,
            400,
            "AUTH_CREDENTIALS_REQUIRED",
            "Email and password are required",
          );
          return;
        }

        if (body.mode === "signup" && !body.registrationTicket) {
          errorResponse(res, 400, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before creating an account");
          return;
        }

        let auth;
        let reservation: string | null = null;
        try {
          if (body.mode === "signup") {
            const reserved = await agent.requestAnonymous<{ reservation: string }>(
              "/api/auth/registration/reserve",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  email: body.email,
                  ticket: body.registrationTicket,
                  inviteCode: body.inviteCode,
                }),
              },
            );
            reservation = reserved.reservation;
          }
          auth = await authenticateWithInsForge(
            config.insforgeUrl,
            body.mode === "signup" ? "signup" : "login",
            body.email,
            body.password,
          );
          if (reservation) {
            await agent.request(auth.accessToken, "/api/auth/registration/finalize", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reservation }),
            });
          }
        } catch (error) {
          if (reservation && !auth) {
            await agent.requestAnonymous("/api/auth/registration/release", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reservation }),
            }).catch(() => undefined);
          }
          if (reservation && auth) {
            errorResponse(res, 409, "REGISTRATION_FINALIZATION_PENDING", "Account created; registration is being finalized");
            return;
          }
          errorResponse(
            res,
            400,
            "AUTHENTICATION_FAILED",
            "Authentication failed",
          );
          return;
        }
        const { cookieValue } = await store.create(auth);
        const flags = cookieFlags(secure, config.sessionTtlSeconds, config.cookieDomain);
        json(res, { ok: true }, 200, {
          "Set-Cookie": `${config.cookieName}=${cookieValue}; ${flags}`,
        });
        return;
      }

      if ((url.pathname === "/api/auth/registration/code" || url.pathname === "/api/auth/registration/verify")
          && req.method === "POST") {
        const body = await parseJsonBody<Record<string, unknown>>(req);
        const requestCookies = parseCookies(req.headers.cookie);
        const hasInvitation = typeof body.inviteCode === "string" && body.inviteCode.trim() !== "";
        const existingDeviceId = requestCookies[REFERRAL_DEVICE_COOKIE_NAME];
        const deviceId = hasInvitation ? existingDeviceId || randomBytes(32).toString("base64url") : undefined;
        if (deviceId) body.deviceId = deviceId;
        const interfaceLocale = req.headers["x-interface-locale"];
        const realIp = req.headers["x-real-ip"];
        const forwarded = req.headers["x-forwarded-for"];
        const clientIp = typeof realIp === "string" ? realIp
          : typeof forwarded === "string" ? forwarded.split(",")[0]!.trim()
            : req.socket.remoteAddress ?? "unknown";
        const result = await agent.requestAnonymous(url.pathname, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof interfaceLocale === "string" ? { "X-Interface-Locale": interfaceLocale } : {}),
            "X-Registration-Client-IP": clientIp,
          },
          body: JSON.stringify(body),
        });
        json(res, result, 200, !existingDeviceId && deviceId ? {
          "Set-Cookie": referralDeviceCookie(deviceId, secure, config.cookieDomain),
        } : {});
        return;
      }

      const referralPreviewMatch = url.pathname.match(/^\/api\/referrals\/preview\/([^/]+)$/);
      if (referralPreviewMatch && req.method === "GET") {
        const requestCookies = parseCookies(req.headers.cookie);
        const existingDeviceId = requestCookies[REFERRAL_DEVICE_COOKIE_NAME];
        const deviceId = existingDeviceId || randomBytes(32).toString("base64url");
        const result = await agent.requestAnonymous(url.pathname);
        json(res, result, 200, existingDeviceId ? {} : {
          "Set-Cookie": referralDeviceCookie(deviceId, secure, config.cookieDomain),
        });
        return;
      }

      if (url.pathname === "/api/auth/logout" && req.method === "POST") {
        const cookies = parseCookies(req.headers.cookie);
        await store.delete(cookies[config.cookieName]);
        const flags = cookieFlags(secure, 0, config.cookieDomain);
        json(res, { ok: true }, 200, {
          "Set-Cookie": `${config.cookieName}=; ${flags}`,
        });
        return;
      }

      // Z-Pay delivers payment notifications as a GET with query params (some
      // integrations POST a form body instead). Both are public, unauthenticated
      // callbacks — normalize to a form-urlencoded POST body for the agent server.
      if (url.pathname === "/api/payments/zpay/notify" && (req.method === "GET" || req.method === "POST")) {
        const body = req.method === "GET"
          ? (url.search ? url.search.slice(1) : "")
          : (await readBody(req, 64 * 1024)).toString("utf8");
        const upstream = await fetch(`${config.agentServerUrl}${url.pathname}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8" });
        res.end(text);
        return;
      }

      const cookies = parseCookies(req.headers.cookie);
      // Local mode does not read the cookie session store: the identity is fixed
      // and nothing is signed, so a synthetic session is always present. Every
      // `!session` guard below therefore becomes unreachable, and the `user_id`
      // stamping keeps working with the local identity instead of a hosted one —
      // the hosted path stays byte-for-byte unchanged.
      const session = config.localMode ? localSession() : await store.get(cookies[config.cookieName]);

      // Available LLM models — novel-agents reads them from the credit_rates
      // table. No auth required upstream, so forward before the session guard.
      if (url.pathname === "/api/models" && req.method === "GET") {
        const upstream = await fetch(`${config.agentServerUrl}/api/models`);
        await forwardUpstreamResponse(res, upstream, "application/json");
        return;
      }

      // Community public reads — anonymous forwarding (no session required).
      // Excludes /me/interactions and /articles/following which require login.
      if (!session && req.method === "GET" && url.pathname.startsWith("/api/community/")
          && url.pathname !== "/api/community/me/interactions"
          && url.pathname !== "/api/community/me/feedback"
          && url.pathname !== "/api/community/me/admin"
          && url.pathname !== "/api/community/articles/following"
          && !/^\/api\/community\/users\/[^/]+\/following-state$/.test(url.pathname)) {
        const upstream = await fetch(`${config.agentServerUrl}${url.pathname}${url.search}`);
        await forwardUpstreamResponse(res, upstream, "application/json");
        return;
      }

      if (url.pathname === "/api/me" && req.method === "GET") {
        if (!session) {
          errorResponse(res, 401, "UNAUTHORIZED", "Authentication is required");
          return;
        }
        let isCommunityAdmin = false;
        try {
          const communityMe = await agent.request(session.accessToken, "/api/community/me/admin") as {
            isCommunityAdmin?: boolean;
          };
          isCommunityAdmin = communityMe.isCommunityAdmin === true;
        } catch {
          // Community role lookup must not make the authenticated shell unavailable.
        }
        json(res, { user: { id: session.userId, email: session.email, isCommunityAdmin } });
        return;
      }

      if (!session && url.pathname.startsWith("/api/")) {
        errorResponse(res, 401, "UNAUTHORIZED", "Authentication is required");
        return;
      }

      const referralUserRoute = url.pathname === "/api/referrals/me" && req.method === "GET";
      const referralAdminRoute = url.pathname.startsWith("/api/referrals/admin/")
        && ["GET", "PATCH", "POST"].includes(req.method ?? "GET");
      if (session && (referralUserRoute || referralAdminRoute)) {
        const init: RequestInit = { method: req.method };
        if (req.method === "PATCH" || req.method === "POST") {
          const body = await parseJsonBody<Record<string, unknown>>(req);
          delete body.user_id;
          init.headers = { "Content-Type": "application/json" };
          init.body = JSON.stringify(body);
        }
        const result = await agent.requestWithStatus(
          session.accessToken, `${url.pathname}${url.search}`, init,
        );
        json(res, result.data, result.status);
        return;
      }

      const apiTokenCollection = url.pathname === "/api/profile/tokens";
      const apiTokenResource = /^\/api\/profile\/tokens\/[^/]+$/.test(url.pathname);
      if (session && (
        (apiTokenCollection && (req.method === "GET" || req.method === "POST"))
        || (apiTokenResource && req.method === "DELETE")
      )) {
        const init: RequestInit = { method: req.method };
        if (req.method === "POST") {
          let bytes: Buffer;
          try {
            bytes = await readBody(req, 16 * 1024);
          } catch (error) {
            if (error instanceof RequestBodyTooLargeError) {
              errorResponse(res, 413, "PAYLOAD_TOO_LARGE", "Request body too large");
              return;
            }
            throw error;
          }
          let body: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(bytes.toString("utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              errorResponse(res, 400, "INVALID_JSON", "Invalid JSON body");
              return;
            }
            body = parsed as Record<string, unknown>;
          } catch (error) {
            if (error instanceof SyntaxError) {
              errorResponse(res, 400, "INVALID_JSON", "Invalid JSON body");
              return;
            }
            throw error;
          }
          delete body.user_id;
          init.headers = { "Content-Type": "application/json" };
          init.body = JSON.stringify(body);
        }
        const result = await agent.requestWithStatus(session.accessToken, url.pathname, init);
        json(res, result.data, result.status);
        return;
      }

  const profileCreditRoute = url.pathname === "/api/profile"
    || url.pathname === "/api/profile/avatar"
    || url.pathname === "/api/credits/summary"
    || url.pathname === "/api/credits/activity"
    || url.pathname === "/api/credits/transactions"
    || url.pathname === "/api/credits/packages"
    || url.pathname === "/api/credits/purchases"
    || /^\/api\/credits\/purchases\/[^/]+$/.test(url.pathname)
    || url.pathname === "/api/membership/plans"
    || url.pathname === "/api/membership/entitlements"
        || url.pathname === "/api/membership/status"
        || url.pathname === "/api/membership/purchases"
        || /^\/api\/membership\/purchases\/[^/]+$/.test(url.pathname)
        || url.pathname === "/api/settings/llm-keys"
        || /^\/api\/settings\/llm-keys\/[^/]+$/.test(url.pathname)
        || url.pathname === "/api/byok/config";

      if (session && profileCreditRoute) {
        const upstreamUrl = new URL(url.pathname + url.search, "http://agent.local");
        upstreamUrl.searchParams.delete("user_id");
        const upstreamPath = `${upstreamUrl.pathname}${upstreamUrl.search}`;
        if (url.pathname === "/api/profile/avatar" && req.method === "POST") {
          const body = await readBody(req, 2 * 1024 * 1024 + 1);
          const upstream = await fetch(`${config.agentServerUrl}${upstreamPath}`, {
            method: "POST",
            headers: {
              ...bearerHeaders(session.accessToken),
              "Content-Type": String(req.headers["content-type"] ?? "application/octet-stream"),
            },
            body: new Uint8Array(body).buffer,
          });
          const payload: unknown = await upstream.json().catch(() => undefined);
          if (upstream.ok) {
            json(res, payload, upstream.status);
          } else {
            json(res, normalizeUpstreamError(payload), upstream.status);
          }
          return;
        }
        const interfaceLocale = req.headers["x-interface-locale"];
        const init: RequestInit = {
          method: req.method,
          headers: typeof interfaceLocale === "string" ? { "X-Interface-Locale": interfaceLocale } : undefined,
        };
        if (req.method === "PATCH" || req.method === "POST" || req.method === "PUT") {
          const body = await parseJsonBody<Record<string, unknown>>(req);
          delete body.user_id;
          init.headers = { ...init.headers, "Content-Type": "application/json" };
          init.body = JSON.stringify(body);
        }
        const result = await agent.requestWithStatus(session.accessToken, upstreamPath, init);
        json(res, result.data, result.status);
        return;
      }

      if (session && url.pathname === "/api/projects" && req.method === "GET") {
        const result = await agent.request(
          session.accessToken,
          withTrustedUser(url.pathname + url.search, session.userId),
        );
        json(res, result);
        return;
      }

      const projectResource = /^\/api\/projects\/[^/]+$/.test(url.pathname);
      const projectAction = /^\/api\/projects\/[^/]+\/(archive|trash|restore)$/.test(url.pathname);
      const projectPermanent = /^\/api\/projects\/[^/]+\/permanent$/.test(url.pathname);

      if (session && projectResource && req.method === "GET") {
        const result = await agent.request(session.accessToken, url.pathname);
        json(res, result);
        return;
      }

      if (session && projectResource && req.method === "PATCH") {
        const body = await parseJsonBody<Record<string, unknown>>(req);
        const result = await agent.requestWithStatus(session.accessToken, url.pathname, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, user_id: session.userId }),
        });
        json(res, result.data, result.status);
        return;
      }

      if (session && projectAction && req.method === "POST") {
        const result = await agent.requestWithStatus(session.accessToken, url.pathname, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: session.userId }),
        });
        json(res, result.data, result.status);
        return;
      }

      if (session && projectPermanent && req.method === "DELETE") {
        const result = await agent.requestWithStatus(session.accessToken, url.pathname, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: session.userId }),
        });
        json(res, result.data, result.status);
        return;
      }

      if (session && url.pathname === "/api/projects" && req.method === "POST") {
        const body = await parseJsonBody<Record<string, unknown>>(req);
        const result = await agent.request(session.accessToken, "/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, owner_id: session.userId }),
        });
        json(res, result);
        return;
      }

      const projectSessions = /^\/api\/projects\/[^/]+\/sessions$/.test(url.pathname);
      const sessionMessages = /^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname);
      const sessionDelegation = /^\/api\/sessions\/[^/]+\/delegations\/[^/]+\/messages$/.test(url.pathname);
      const sessionResource = /^\/api\/sessions\/[^/]+$/.test(url.pathname);
      const sessionAction = /^\/api\/sessions\/[^/]+\/(archive|restore|interrupt)$/.test(url.pathname);

      if (session && (projectSessions || sessionMessages || sessionDelegation) && req.method === "GET") {
        const result = await agent.request(
          session.accessToken,
          withTrustedUser(url.pathname + url.search, session.userId),
        );
        json(res, result);
        return;
      }

      if (session && (
        (projectSessions && req.method === "POST")
        || (sessionAction && req.method === "POST")
        || (sessionResource && (req.method === "PATCH" || req.method === "DELETE"))
      )) {
        const body = await parseJsonBody<Record<string, unknown>>(req);
        const result = await agent.request(session.accessToken, url.pathname, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, user_id: session.userId }),
        });
        json(res, result);
        return;
      }

      const skillRoute = url.pathname === "/api/skills"
        || /^\/api\/skills\/[^/]+$/.test(url.pathname)
        || /^\/api\/skills\/[^/]+\/versions$/.test(url.pathname)
        || /^\/api\/skills\/[^/]+\/revert$/.test(url.pathname)
        || url.pathname === "/api/skill-drafts"
        || /^\/api\/skill-drafts\/[^/]+(?:\/(?:review|confirm))?$/.test(url.pathname)
        || /^\/api\/workspaces\/[^/]+\/skills(?:\/[^/]+)?$/.test(url.pathname);

      if (session && skillRoute) {
        const init: RequestInit = { method: req.method };
        if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
          const body = await parseJsonBody<Record<string, unknown>>(req);
          delete body.user_id;
          init.headers = { "Content-Type": "application/json" };
          init.body = JSON.stringify({ ...body, user_id: session.userId });
        }
        const result = await agent.requestWithStatus(session.accessToken, url.pathname + url.search, init);
        json(res, result.data, result.status);
        return;
      }

      if (session && url.pathname === "/api/chat/stream" && req.method === "POST") {
        const body = await parseJsonBody<Record<string, unknown>>(req);
        const controller = new AbortController();
        const upstreamBody = JSON.stringify({ ...body, user_id: session.userId });

        // One "close" listener serves both phases: it lets the retry loop bail
        // out early if the browser left, and aborts any in-flight upstream
        // fetch so we stop reading from the agent server for a dead client.
        // (We can't use `req.destroyed`: Node sets it eagerly after the request
        // body drains for small payloads, which would kill healthy retries.)
        let clientGone = false;
        const onClientClose = () => {
          clientGone = true;
          controller.abort();
        };
        req.on("close", onClientClose);

        try {
          // Retry the upstream connection only while no bytes have been
          // streamed to the browser yet. Once a single SSE chunk has been
          // written the request is committed (a turn may already exist
          // server-side), so mid-stream failures never replay.
          const MAX_UPSTREAM_ATTEMPTS = 3;
          const UPSTREAM_BACKOFF_MS = [300, 800];

          let upstream: Response | null = null;

          for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt++) {
            if (clientGone) break;
            try {
              upstream = await fetch(`${config.agentServerUrl}/api/chat`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...bearerHeaders(session.accessToken),
                },
                body: upstreamBody,
                signal: controller.signal,
              });
            } catch (err) {
              // AbortError means the client disconnected — never retry.
              const isAbort = err instanceof Error && err.name === "AbortError";
              if (isAbort || attempt === MAX_UPSTREAM_ATTEMPTS - 1) {
                upstream = null;
                break;
              }
              await new Promise((r) => setTimeout(r, UPSTREAM_BACKOFF_MS[attempt] + Math.random() * 150));
              continue;
            }

            // 5xx is the only status we retry — agent server transient failure.
            if (upstream.status >= 500 && upstream.status < 600 && attempt < MAX_UPSTREAM_ATTEMPTS - 1) {
              await upstream.body?.cancel().catch(() => {});
              await new Promise((r) => setTimeout(r, UPSTREAM_BACKOFF_MS[attempt] + Math.random() * 150));
              upstream = null;
              continue;
            }
            break;
          }

          // All attempts failed at the network level — surface a 502 so the
          // browser-side retry can take over (or the user sees a clear failure).
          if (!upstream) {
            if (!res.writableEnded) {
              errorResponse(
                res,
                502,
                "UPSTREAM_UNAVAILABLE",
                "The service is temporarily unavailable",
              );
            }
            return;
          }

          if (!upstream.ok || !upstream.body) {
            const text = await upstream.text();
            let payload: unknown;
            try {
              payload = text ? JSON.parse(text) : undefined;
            } catch {
              payload = undefined;
            }
            json(res, normalizeUpstreamError(payload), upstream.status);
            return;
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          try {
            for await (const chunk of upstream.body as any) {
              res.write(chunk);
            }
          } catch {
            // Client disconnect or upstream abort — expected during long runs.
          }
        } finally {
          req.off("close", onClientClose);
        }

        if (!res.writableEnded) res.end();
        return;
      }

      // Export: stream binary response to browser
      const exportMatch = url.pathname.match(/^\/api\/documents\/(.+)\/export\/(md|txt|docx)$/);
      if (session && exportMatch && req.method === "GET") {
        const upstreamPath = url.pathname + url.search;
        const upstream = await fetch(`${config.agentServerUrl}${upstreamPath}`, {
          headers: bearerHeaders(session.accessToken),
        });
        if (!upstream.ok) {
          const text = await upstream.text();
          let payload: unknown;
          try { payload = text ? JSON.parse(text) : undefined; } catch { payload = undefined; }
          json(res, normalizeUpstreamError(payload), upstream.status);
          return;
        }
        const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
        const contentDisposition = upstream.headers.get("content-disposition") ?? "attachment";
        const contentLength = upstream.headers.get("content-length");
        res.writeHead(upstream.status, {
          "Content-Type": contentType,
          "Content-Disposition": contentDisposition,
          ...(contentLength ? { "Content-Length": contentLength } : {}),
        });
        if (upstream.body) {
          for await (const chunk of upstream.body as any) {
            res.write(chunk);
          }
        }
        res.end();
        return;
      }

      if (session && url.pathname.startsWith("/api/documents/")) {
        const upstreamPath = url.pathname + url.search;
        const init: RequestInit = { method: req.method };
        if (req.method === "PUT" || req.method === "DELETE") {
          const body = await parseJsonBody<Record<string, unknown>>(req);
          init.headers = { "Content-Type": "application/json" };
          init.body = JSON.stringify({ ...body, user_id: session.userId });
        }
        const result = await agent.request(session.accessToken, upstreamPath, init);
        json(res, result);
        return;
      }

      if (!session && url.pathname.startsWith("/api/document-versions/")) {
        errorResponse(res, 401, "UNAUTHORIZED", "Authentication is required");
        return;
      }

      if (session && url.pathname.startsWith("/api/document-versions/") && req.method === "GET") {
        const upstreamUrl = new URL(url.pathname + url.search, "http://agent.local");
        upstreamUrl.searchParams.delete("user_id");
        const result = await agent.requestWithStatus(
          session.accessToken,
          `${upstreamUrl.pathname}${upstreamUrl.search}`,
          { method: "GET" },
        );
        json(res, result.data, result.status);
        return;
      }

      // Community: authenticated routes — forward with session token so RLS can see the user.
      const communityRoute =
        (req.method === "GET" && url.pathname.startsWith("/api/community/"))
        ||
        (req.method === "POST" && url.pathname === "/api/community/articles")
        || (req.method === "PATCH" && /^\/api\/community\/articles\/[^/]+$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/community\/articles\/[^/]+$/.test(url.pathname))
        || (req.method === "POST" && /^\/api\/community\/articles\/[^/]+\/publish$/.test(url.pathname))
        || (req.method === "POST" && /^\/api\/community\/articles\/[^/]+\/feature$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/community\/articles\/[^/]+\/feature$/.test(url.pathname))
        || (req.method === "POST" && /^\/api\/community\/articles\/[^/]+\/hide$/.test(url.pathname))
        || (req.method === "PATCH" && /^\/api\/community\/articles\/[^/]+\/feedback-status$/.test(url.pathname))
        || (req.method === "POST" && /^\/api\/community\/articles\/[^/]+\/like$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/community\/articles\/[^/]+\/like$/.test(url.pathname))
        || (req.method === "POST" && /^\/api\/community\/articles\/[^/]+\/bookmark$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/community\/articles\/[^/]+\/bookmark$/.test(url.pathname))
        || (req.method === "POST" && /^\/api\/community\/articles\/[^/]+\/comments$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/community\/comments\/[^/]+$/.test(url.pathname))
        || (req.method === "POST" && /^\/api\/community\/comments\/[^/]+\/like$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/community\/comments\/[^/]+\/like$/.test(url.pathname))
        || (req.method === "POST" && /^\/api\/community\/users\/[^/]+\/follow$/.test(url.pathname))
        || (req.method === "DELETE" && /^\/api\/community\/users\/[^/]+\/follow$/.test(url.pathname))
        || (req.method === "GET" && url.pathname === "/api/community/me/interactions")
        || (req.method === "GET" && url.pathname === "/api/community/me/feedback")
        || (req.method === "GET" && url.pathname === "/api/community/articles/following");

      if (session && communityRoute) {
        const upstreamUrl = new URL(url.pathname + url.search, "http://agent.local");
        upstreamUrl.searchParams.delete("user_id");
        const upstreamPath = `${upstreamUrl.pathname}${upstreamUrl.search}`;
        const init: RequestInit = { method: req.method };
        if (req.method === "PATCH" || req.method === "POST") {
          const bytes = await readBody(req, 64 * 1024);
          if (bytes.length > 0) {
            const body = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
            delete body.user_id;
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
          }
        }
        const result = await agent.requestWithStatus(session.accessToken, upstreamPath, init);
        json(res, result.data, result.status);
        return;
      }

      errorResponse(res, 404, "NOT_FOUND", "Not found");
    } catch (err) {
      if (err instanceof AgentApiError) {
        json(res, err.payload, err.status);
        return;
      }
      if (err instanceof SyntaxError) {
        errorResponse(res, 400, "INVALID_JSON", "Invalid JSON body");
        return;
      }
      if (err instanceof RequestBodyTooLargeError) {
        errorResponse(res, 413, "PAYLOAD_TOO_LARGE", "Request body too large");
        return;
      }
      errorResponse(res, 500, "INTERNAL_ERROR");
    }
  };
}
