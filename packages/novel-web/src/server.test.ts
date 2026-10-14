import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "./routes.js";
import { SessionStore } from "./sessions.js";

// `webui-dist/` is prebuilt WebUI output (see AGENTS.md "WebUI Build and Deployment
// Boundary"): the hosted deployment ships it, a fresh public clone does not until the
// self-hoster runs `make build-webui-dist`. The `/community` page serves the built
// template from it, so tests that exercise that page are skipped when the artifact is
// absent — every other BFF test runs in both repositories.
const hasWebuiDist = existsSync(fileURLToPath(new URL("../../../webui-dist", import.meta.url)));

describe("SessionStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the InsForge access token server-side", async () => {
    const store = new SessionStore("test-secret", 60);
    const { cookieValue } = await store.create({
      userId: "user-1",
      email: "u@example.com",
      accessToken: "insforge-access-token",
      refreshToken: "insforge-refresh-token",
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 900,
    });

    expect(cookieValue).not.toContain("insforge-access-token");
    const session = await store.get(cookieValue);
    expect(session?.accessToken).toBe("insforge-access-token");
  });

  it("rejects invalid cookies", async () => {
    const store = new SessionStore("test-secret", 60);
    await expect(store.get("bad-cookie")).resolves.toBeNull();
  });

  it("refreshes an expired InsForge access token and persists rotated tokens", async () => {
    const refresh = vi.fn(async () => ({
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token",
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 900,
    }));
    const store = new SessionStore("test-secret", 60, refresh);
    const { cookieValue } = await store.create({
      userId: "user-1",
      email: "u@example.com",
      accessToken: "expired-access-token",
      refreshToken: "initial-refresh-token",
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) - 1,
    });

    const session = await store.get(cookieValue);

    expect(refresh).toHaveBeenCalledWith("initial-refresh-token");
    expect(session?.accessToken).toBe("fresh-access-token");
    expect(session?.refreshToken).toBe("rotated-refresh-token");
  });

  it("deduplicates concurrent refreshes for the same session", async () => {
    type RefreshedTokens = Pick<import("./sessions.js").WebSession, "accessToken" | "refreshToken" | "accessTokenExpiresAt">;
    let resolveRefresh!: (value: RefreshedTokens) => void;
    const refresh = vi.fn(() => new Promise<RefreshedTokens>((resolve) => { resolveRefresh = resolve; }));
    const store = new SessionStore("test-secret", 60, refresh);
    const { cookieValue } = await store.create({
      userId: "user-1",
      email: "u@example.com",
      accessToken: "expired-access-token",
      refreshToken: "initial-refresh-token",
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) - 1,
    });

    const first = store.get(cookieValue);
    const second = store.get(cookieValue);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    resolveRefresh({
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token",
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 900,
    });

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { accessToken: "fresh-access-token" },
      { accessToken: "fresh-access-token" },
    ]);
  });

  it("removes expired abandoned sessions without their cookie being presented", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T00:00:00Z"));
    const store = new SessionStore("test-secret", 1, undefined, 30, {
      cleanupIntervalMs: 1_000,
      maxSessions: 10,
      maxSessionsPerUser: 10,
    });
    await store.create({
      userId: "user-1",
      email: "u@example.com",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 900,
    });

    expect(store.size).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.size).toBe(0);
    store.close();
  });

  it("bounds total sessions and sessions per user", async () => {
    const store = new SessionStore("test-secret", 60, undefined, 30, {
      cleanupIntervalMs: 60_000,
      maxSessions: 3,
      maxSessionsPerUser: 2,
    });
    const create = (userId: string) => store.create({
      userId,
      email: `${userId}@example.com`,
      accessToken: `access-${userId}`,
      refreshToken: `refresh-${userId}`,
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 900,
    });

    const first = await create("user-1");
    await create("user-1");
    await create("user-1");
    expect(await store.get(first.cookieValue)).toBeNull();
    expect(store.size).toBe(2);

    await create("user-2");
    await create("user-3");
    expect(store.size).toBe(3);
    store.close();
  });
});

describe("web routes", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const config = {
    port: 0,
    insforgeUrl: "http://insforge.test",
    agentServerUrl: "http://agent.test",
    jwtSecret: "test-secret",
    cookieName: "__Secure-novel_session",
    cookieDomain: "lingqiai.art",
    allowedOrigins: ["https://lingqiai.art", "https://app.lingqiai.art"],
    sessionTtlSeconds: 60,
    webuiDistDir: fileURLToPath(new URL("../../../webui-dist", import.meta.url)),
    indexNowKey: "12345678",
    localMode: false,
  };

  async function withServer<T>(
    fn: (baseUrl: string) => Promise<T>,
    store?: SessionStore,
  ): Promise<T> {
    const server = createServer(createHandler(config, store));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    try {
      return await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  }

  async function login(baseUrl: string): Promise<string> {
    const res = await originalFetch(`${baseUrl}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "u@example.com", password: "secret", mode: "login" }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    return cookie ?? "";
  }

  function tokenWithExp(exp: number): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp })}.signature`;
  }

  it("returns 401 for /api/me without a session", async () => {
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/me`);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({
        error: { code: "UNAUTHORIZED", message: "Authentication is required" },
      });
    });
  });

  it("returns a stable validation error when login credentials are missing", async () => {
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "u@example.com" }),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "AUTH_CREDENTIALS_REQUIRED",
          message: "Email and password are required",
        },
      });
    });
  });

  it("returns INVALID_JSON without exposing parser diagnostics", async () => {
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"password":"secret-value"',
      });

      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload).toEqual({
        error: { code: "INVALID_JSON", message: "Invalid JSON body" },
      });
      expect(JSON.stringify(payload)).not.toContain("secret-value");
    });
  });

  it("returns PAYLOAD_TOO_LARGE for oversized bodies outside token routes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "refresh",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/community/articles`, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ body: "x".repeat(65 * 1024) }),
      });

      expect(res.status).toBe(413);
      await expect(res.json()).resolves.toEqual({
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" },
      });
    });
  });

  it("keeps genuinely unknown failures as sanitized INTERNAL_ERROR responses", async () => {
    class ExplodingSessionStore extends SessionStore {
      override async get(): Promise<never> {
        throw new Error("database password leaked");
      }
    }
    const store = new ExplodingSessionStore("test-secret", 60);

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/me`);

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({
        error: { code: "INTERNAL_ERROR" },
      });
    }, store);
  });

  it("creates an opaque cookie on login and uses it for /api/me", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/community/me/admin") {
        return new Response(JSON.stringify({ isCommunityAdmin: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input);
    }));

    await withServer(async (baseUrl) => {
      const login = await originalFetch(`${baseUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-proto": "https" },
        body: JSON.stringify({ email: "u@example.com", password: "secret", mode: "login" }),
      });
      expect(login.status).toBe(200);

      const cookie = login.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("__Secure-novel_session=");
      expect(cookie).toContain("Domain=lingqiai.art");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      expect(login.headers.getSetCookie()).toHaveLength(1);
      expect(cookie).not.toContain("insforge-access-token");

      const me = await originalFetch(`${baseUrl}/api/me`, { headers: { cookie } });
      expect(me.status).toBe(200);
      await expect(me.json()).resolves.toEqual({
        user: { id: "user-1", email: "u@example.com", isCommunityAdmin: true },
      });
    });
  });

  it("clears the shared-domain cookie with matching security attributes", async () => {
    await withServer(async (baseUrl) => {
      const logout = await originalFetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { "x-forwarded-proto": "https" },
      });

      expect(logout.status).toBe(200);
      const cookie = logout.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("__Secure-novel_session=");
      expect(cookie).toContain("Domain=lingqiai.art");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Max-Age=0");
    });
  });

  it("rejects disallowed browser origins before forwarding community mutations", async () => {
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/community/articles/a1/like") {
        return new Response(JSON.stringify({ liked: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal("fetch", upstreamFetch);

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      upstreamFetch.mockClear();

      const rejected = await originalFetch(`${baseUrl}/api/community/articles/a1/like`, {
        method: "POST",
        headers: { cookie, origin: "https://attacker.example" },
      });
      expect(rejected.status).toBe(403);
      await expect(rejected.json()).resolves.toEqual({
        error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin not allowed" },
      });
      expect(upstreamFetch).not.toHaveBeenCalled();

      const allowed = await originalFetch(`${baseUrl}/api/community/articles/a1/like`, {
        method: "POST",
        headers: { cookie, origin: "https://lingqiai.art" },
      });
      expect(allowed.status).toBe(200);
      expect(upstreamFetch).toHaveBeenCalledWith(
        "http://agent.test/api/community/articles/a1/like",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("refreshes an expired InsForge token before proxying an authenticated request", async () => {
    const expiredToken = tokenWithExp(Math.floor(Date.now() / 1000) - 1);
    const freshToken = tokenWithExp(Math.floor(Date.now() / 1000) + 900);
    let refreshBody: unknown;
    let upstreamAuth = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: expiredToken,
          refreshToken: "initial-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://insforge.test/api/auth/refresh?client_type=server") {
        refreshBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          accessToken: freshToken,
          refreshToken: "rotated-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/projects?status=active&user_id=user-1") {
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const projects = await originalFetch(`${baseUrl}/api/projects?status=active`, { headers: { cookie } });

      expect(projects.status).toBe(200);
      expect(refreshBody).toEqual({ refreshToken: "initial-refresh-token" });
      expect(upstreamAuth).toBe(`Bearer ${freshToken}`);
    });
  });

  it("returns 400 when InsForge rejects login", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({ error: "Invalid credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input);
    }));

    await withServer(async (baseUrl) => {
      const login = await originalFetch(`${baseUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "u@example.com", password: "wrong", mode: "login" }),
      });
      expect(login.status).toBe(400);
      await expect(login.json()).resolves.toEqual({
        error: { code: "AUTHENTICATION_FAILED", message: "Authentication failed" },
      });
    });
  });

  it("reserves and finalizes a verified ticket when signing up", async () => {
    let signupUrl = "";
    const callOrder: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://agent.test/api/auth/registration/reserve") {
        callOrder.push("reserve");
        return new Response(JSON.stringify({ reservation: "reservation-token" }), { status: 200 });
      }
      if (url.startsWith("http://insforge.test/api/auth/users")) {
        callOrder.push("signup");
        signupUrl = url;
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/auth/registration/finalize") {
        callOrder.push("finalize");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer insforge-access-token");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const signup = await originalFetch(`${baseUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "u@example.com", password: "secret", mode: "signup",
          registrationTicket: "verified-ticket",
        }),
      });

      expect(signup.status).toBe(200);
      expect(signupUrl).toBe("http://insforge.test/api/auth/users?client_type=server");
      expect(callOrder).toEqual(["reserve", "signup", "finalize"]);
    });
  });

  it("sets a durable referral device cookie and forwards it only to the agent", async () => {
    let forwardedBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "http://agent.test/api/auth/registration/code") {
        forwardedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ accepted: true, retryAfterSeconds: 60 }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));
    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/api/auth/registration/code`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "u@example.com", inviteCode: "ABCD2345" }),
      });
      expect(response.headers.get("set-cookie")).toMatch(/novel_referral_device=.*HttpOnly.*SameSite=Lax/);
      expect(forwardedBody).toMatchObject({ email: "u@example.com", inviteCode: "ABCD2345", deviceId: expect.any(String) });
    });
  });

  it("requires a verification ticket for signup but not login", async () => {
    await withServer(async (baseUrl) => {
      const signup = await originalFetch(`${baseUrl}/api/auth`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "u@example.com", password: "secret", mode: "signup" }),
      });
      expect(signup.status).toBe(400);
      await expect(signup.json()).resolves.toMatchObject({ error: { code: "EMAIL_VERIFICATION_REQUIRED" } });
    });
  });

  it("does not expose the removed client config endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/config`, {
        headers: { cookie, "x-forwarded-proto": "https" },
      });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: { code: "NOT_FOUND", message: "Not found" },
      });
    });
  });

  it("proxies project creation with the InsForge access token", async () => {
    let upstreamAuth = "";
    let upstreamBody: any = null;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/projects") {
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        upstreamBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ project: { id: "project-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: "Novel" }),
      });

      expect(res.status).toBe(200);
      expect(upstreamAuth).toBe("Bearer insforge-access-token");
      expect(upstreamBody).toMatchObject({ title: "Novel", owner_id: "user-1" });
      await expect(res.json()).resolves.toEqual({ project: { id: "project-1" } });
    });
  });

  it("lists projects scoped to the authenticated user", async () => {
    let upstreamAuth = "";

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/projects?user_id=user-1") {
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ projects: [{ id: "project-1", title: "Novel" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/projects`, { headers: { cookie } });

      expect(res.status).toBe(200);
      expect(upstreamAuth).toBe("Bearer insforge-access-token");
      await expect(res.json()).resolves.toEqual({ projects: [{ id: "project-1", title: "Novel" }] });
    });
  });

  it("proxies authenticated profile APIs without trusting a forged user id", async () => {
    let forwardedBody: unknown;
    let forwardedAuth = "";
    let upstreamRequest: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({ user: { id: "user-1", email: "u@example.com" }, accessToken: "insforge-access-token", refreshToken: "insforge-refresh-token" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/profile") {
        upstreamRequest = init;
        forwardedAuth = new Headers(init?.headers).get("authorization") ?? "";
        forwardedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "user-1", displayName: "墨白" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/profile`, {
        method: "PATCH", headers: { cookie, "Content-Type": "application/json", "x-interface-locale": "en" },
        body: JSON.stringify({ displayName: "墨白", user_id: "attacker" }),
      });
      expect(res.status).toBe(200);
      expect(forwardedAuth).toBe("Bearer insforge-access-token");
      expect(forwardedBody).toEqual({ displayName: "墨白" });
      expect(new Headers(upstreamRequest?.headers).get("X-Interface-Locale")).toBe("en");
    });
  });

  it("proxies only exact API token management routes with the web session token", async () => {
    const upstream: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({ user: { id: "real-user", email: "u@example.com" }, accessToken: "insforge-access-token", refreshToken: "refresh" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("http://agent.test/api/profile/tokens")) {
        upstream.push({
          url,
          method: init?.method ?? "GET",
          auth: new Headers(init?.headers).get("authorization") ?? "",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      await originalFetch(`${baseUrl}/api/profile/tokens?user_id=attacker`, { headers: { cookie } });
      await originalFetch(`${baseUrl}/api/profile/tokens`, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "CLI", lifetimeDays: 30, scopes: ["projects:read"], user_id: "attacker" }),
      });
      await originalFetch(`${baseUrl}/api/profile/tokens/token-1`, { method: "DELETE", headers: { cookie } });
      const extra = await originalFetch(`${baseUrl}/api/profile/tokens/token-1/details`, { headers: { cookie } });
      expect(extra.status).toBe(404);
    });

    expect(upstream.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "http://agent.test/api/profile/tokens", method: "GET" },
      { url: "http://agent.test/api/profile/tokens", method: "POST" },
      { url: "http://agent.test/api/profile/tokens/token-1", method: "DELETE" },
    ]);
    expect(upstream.every((request) => request.auth === "Bearer insforge-access-token")).toBe(true);
    expect(upstream[1].body).toEqual({ name: "CLI", lifetimeDays: 30, scopes: ["projects:read"] });
  });

  it("rejects API token management without a web session", async () => {
    await withServer(async (baseUrl) => {
      for (const [path, method] of [["/api/profile/tokens", "GET"], ["/api/profile/tokens", "POST"], ["/api/profile/tokens/token-1", "DELETE"]]) {
        const res = await originalFetch(`${baseUrl}${path}`, { method });
        expect(res.status).toBe(401);
      }
    });
  });

  it("proxies BYOK key management routes with the web session token and strips user_id", async () => {
    const upstream: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({ user: { id: "real-user", email: "u@example.com" }, accessToken: "insforge-access-token", refreshToken: "refresh" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("http://agent.test/api/settings/llm-keys") || url.startsWith("http://agent.test/api/byok/config")) {
        upstream.push({
          url,
          method: init?.method ?? "GET",
          auth: new Headers(init?.headers).get("authorization") ?? "",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      await originalFetch(`${baseUrl}/api/settings/llm-keys?user_id=attacker`, { headers: { cookie } });
      await originalFetch(`${baseUrl}/api/settings/llm-keys`, {
        method: "PUT",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "deepseek", api_key: "sk-test-1234567890", user_id: "attacker" }),
      });
      await originalFetch(`${baseUrl}/api/settings/llm-keys/deepseek`, { method: "DELETE", headers: { cookie } });
      await originalFetch(`${baseUrl}/api/byok/config`, { headers: { cookie } });
    });

    expect(upstream.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: "http://agent.test/api/settings/llm-keys", method: "GET" },
      { url: "http://agent.test/api/settings/llm-keys", method: "PUT" },
      { url: "http://agent.test/api/settings/llm-keys/deepseek", method: "DELETE" },
      { url: "http://agent.test/api/byok/config", method: "GET" },
    ]);
    expect(upstream.every((request) => request.auth === "Bearer insforge-access-token")).toBe(true);
    expect(upstream[1].body).toEqual({ provider: "deepseek", api_key: "sk-test-1234567890" });
  });

  it.each([
    ["malformed JSON", "{not-json", 400],
    ["non-object JSON", "null", 400],
    ["a body over 16 KiB", JSON.stringify({ name: "x".repeat(17 * 1024) }), 413],
  ])("rejects token POST with %s before proxying", async (_case, body, status) => {
    let agentCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "refresh",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("http://agent.test/")) agentCalls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/profile/tokens`, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(status);
      await expect(res.json()).resolves.toEqual({
        error: status === 413
          ? { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" }
          : { code: "INVALID_JSON", message: "Invalid JSON body" },
      });
    });
    expect(agentCalls).toBe(0);
  });

  it("forwards the public Z-Pay callback as raw form data", async () => {
    let forwarded = "";
    let auth: string | null = "unexpected";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://agent.test/api/payments/zpay/notify") {
        forwarded = String(init?.body);
        auth = new Headers(init?.headers).get("authorization");
        return new Response("success", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return originalFetch(input, init);
    }));
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/payments/zpay/notify`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "b=2&a=1&sign=x",
      });
      expect(await res.text()).toBe("success");
      expect(forwarded).toBe("b=2&a=1&sign=x");
      expect(auth).toBeNull();
    });
  });

  it("forwards Z-Pay GET callback query string as a form-urlencoded POST body", async () => {
    let forwarded = "";
    let method = "unexpected";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u === "http://agent.test/api/payments/zpay/notify") {
        forwarded = String(init?.body);
        method = init?.method ?? "none";
        return new Response("success", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return originalFetch(input, init);
    }));
    await withServer(async (baseUrl) => {
      const res = await originalFetch(
        `${baseUrl}/api/payments/zpay/notify?out_trade_no=MC-1&trade_no=T1&money=9.90&trade_status=TRADE_SUCCESS&sign=abc`,
        { method: "GET" },
      );
      expect(await res.text()).toBe("success");
      expect(method).toBe("POST");
      expect(forwarded).toBe("out_trade_no=MC-1&trade_no=T1&money=9.90&trade_status=TRADE_SUCCESS&sign=abc");
    });
  });

  it("proxies project lifecycle management with trusted identity and status", async () => {
    const upstream: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "real-user", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("http://agent.test/api/projects")) {
        upstream.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        const permanent = url.endsWith("/permanent");
        return new Response(JSON.stringify(permanent ? { jobId: "job-1" } : { ok: true }), {
          status: permanent ? 202 : 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const jsonHeaders = { "Content-Type": "application/json", cookie };
      await originalFetch(`${baseUrl}/api/projects?status=archived&user_id=forged`, { headers: { cookie } });
      await originalFetch(`${baseUrl}/api/projects/project-1`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ title: "Renamed", user_id: "forged" }),
      });
      await originalFetch(`${baseUrl}/api/projects/project-1/archive`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ user_id: "forged" }),
      });
      const permanent = await originalFetch(`${baseUrl}/api/projects/project-1/permanent`, {
        method: "DELETE",
        headers: jsonHeaders,
        body: JSON.stringify({ user_id: "forged" }),
      });
      expect(permanent.status).toBe(202);
    });

    expect(upstream[0].url).toContain("status=archived");
    expect(upstream[0].url).toContain("user_id=real-user");
    expect(upstream[0].url).not.toContain("forged");
    expect(upstream.slice(1).map((request) => request.body?.user_id)).toEqual([
      "real-user", "real-user", "real-user",
    ]);
    expect(upstream.map((request) => request.method)).toEqual(["GET", "PATCH", "POST", "DELETE"]);
  });

  it("preserves project lifecycle conflict payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/projects/project-1/archive") {
        return new Response(JSON.stringify({
          error: {
            code: "RESOURCE_BUSY",
            message: "busy",
            details: { sessionId: "s1" },
            internalTrace: "must-not-leak",
          },
          debug: "must-not-leak",
        }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/projects/project-1/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "RESOURCE_BUSY",
          message: "busy",
          details: { sessionId: "s1" },
        },
      });
    });
  });

  it("sanitizes anonymous upstream JSON errors before forwarding them", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "http://agent.test/api/community/articles/missing") {
        return new Response(JSON.stringify({
          error: { code: "ARTICLE_NOT_FOUND", message: "Not found", stack: "secret" },
          query: "secret",
        }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input);
    }));

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/community/articles/missing`);

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: { code: "ARTICLE_NOT_FOUND", message: "Not found" },
      });
    });
  });

  it("proxies document updates with user ownership context", async () => {
    let upstreamAuth = "";
    let upstreamBody: any = null;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/documents/project-1/world.md") {
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        upstreamBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/documents/project-1/world.md`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          content: "---\ntype: worldview\n---\n# World",
          base_hash: "hash-old",
        }),
      });

      expect(res.status).toBe(200);
      expect(upstreamAuth).toBe("Bearer insforge-access-token");
      expect(upstreamBody).toMatchObject({
        content: "---\ntype: worldview\n---\n# World",
        base_hash: "hash-old",
        user_id: "user-1",
      });
      await expect(res.json()).resolves.toEqual({ ok: true });
    });
  });

  it("preserves structured document conflict responses", async () => {
    const conflict = {
      error: "Document conflict",
      code: "DOCUMENT_CONFLICT",
      content: "remote content",
      hash: "remote-hash",
      path: "text/chapter-001.md",
    };

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/documents/project-1/text/chapter-001.md") {
        return new Response(JSON.stringify(conflict), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/documents/project-1/text/chapter-001.md`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ content: "local draft", base_hash: "stale-hash" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        error: { code: "DOCUMENT_CONFLICT" },
      });
    });
  });

  it("requires auth and proxies document version reads without forged user context", async () => {
    let upstreamUrl = "";
    let upstreamAuth = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("http://agent.test/api/document-versions/v1/diff")) {
        upstreamUrl = url;
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const unauthenticated = await originalFetch(`${baseUrl}/api/document-versions/v1`);
      expect(unauthenticated.status).toBe(401);

      const cookie = await login(baseUrl);
      const response = await originalFetch(
        `${baseUrl}/api/document-versions/v1/diff?cursor=0&limit=10&user_id=forged`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(200);
      expect(upstreamAuth).toBe("Bearer insforge-access-token");
      expect(upstreamUrl).toBe("http://agent.test/api/document-versions/v1/diff?cursor=0&limit=10");
    });
  });

  it("returns 401 for session routes without an authenticated web session", async () => {
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/projects/project-1/sessions`);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({
        error: { code: "UNAUTHORIZED", message: "Authentication is required" },
      });

      const interrupt = await originalFetch(`${baseUrl}/api/sessions/session-1/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(interrupt.status).toBe(401);
    });
  });

  it("proxies durable session routes with the trusted user id", async () => {
    const upstream: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "real-user", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("http://agent.test/api/")) {
        upstream.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const headers = { "Content-Type": "application/json", cookie };
      await originalFetch(
        `${baseUrl}/api/projects/project-1/sessions?status=archived&cursor=a%2Fb&search=%E4%BA%BA%E7%89%A9&user_id=forged-user`,
        { headers: { cookie } },
      );
      await originalFetch(`${baseUrl}/api/projects/project-1/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id: "forged-user" }),
      });
      await originalFetch(`${baseUrl}/api/sessions/session-1/messages?limit=20`, {
        headers: { cookie },
      });
      await originalFetch(`${baseUrl}/api/sessions/session-1`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ title: "标题", user_id: "forged-user" }),
      });
      await originalFetch(`${baseUrl}/api/sessions/session-1`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ user_id: "forged-user" }),
      });
      await originalFetch(`${baseUrl}/api/sessions/session-1/archive`, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id: "forged-user" }),
      });
      await originalFetch(`${baseUrl}/api/sessions/session-1/restore`, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id: "forged-user" }),
      });
      await originalFetch(`${baseUrl}/api/sessions/session-1/interrupt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_id: "forged-user" }),
      });
    });

    expect(upstream[0].url).toContain("cursor=a%2Fb");
    expect(upstream[0].url).toContain("search=%E4%BA%BA%E7%89%A9");
    expect(upstream[0].url).toContain("status=archived");
    expect(upstream[0].url).toContain("user_id=real-user");
    expect(upstream[0].url).not.toContain("forged-user");
    expect(upstream.slice(1).filter((request) => request.body).map((request) => request.body.user_id))
      .toEqual(["real-user", "real-user", "real-user", "real-user", "real-user", "real-user"]);
    expect(upstream.some((request) => request.url.endsWith("/api/sessions/session-1/archive"))).toBe(true);
    expect(upstream.some((request) => request.url.endsWith("/api/sessions/session-1/restore"))).toBe(true);
    expect(upstream.some((request) => request.url.endsWith("/api/sessions/session-1/interrupt"))).toBe(true);
  });

  it("proxies community reads with the authenticated session token when logged in", async () => {
    const upstream: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "real-user", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("http://agent.test/api/community/")) {
        const headers = new Headers(init?.headers);
        upstream.push({ url, auth: headers.get("Authorization") });
        return new Response(JSON.stringify({ article: { id: "draft-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/community/articles/draft-1`, {
        headers: { cookie },
      });

      expect(res.status).toBe(200);
      expect(upstream).toEqual([{
        url: "http://agent.test/api/community/articles/draft-1",
        auth: "Bearer insforge-access-token",
      }]);
    });
  });

  it("allows anonymous community reads but rejects anonymous community interactions", async () => {
    const upstream: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://agent.test/api/community/")) {
        upstream.push({ url, method: init?.method ?? "GET" });
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const readRes = await originalFetch(`${baseUrl}/api/community/articles`);
      expect(readRes.status).toBe(200);

      const writeRes = await originalFetch(`${baseUrl}/api/community/articles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Anon", body: "Body", section: "prompt" }),
      });
      expect(writeRes.status).toBe(401);

      const commentRes = await originalFetch(`${baseUrl}/api/community/articles/a1/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Anon comment" }),
      });
      expect(commentRes.status).toBe(401);

      const likeRes = await originalFetch(`${baseUrl}/api/community/articles/a1/like`, { method: "POST" });
      expect(likeRes.status).toBe(401);

      const feedbackRes = await originalFetch(`${baseUrl}/api/community/me/feedback`);
      expect(feedbackRes.status).toBe(401);
    });

    expect(upstream).toEqual([{ url: "http://agent.test/api/community/articles", method: "GET" }]);
  });

  it.skipIf(!hasWebuiDist)("serves crawlable community HTML, robots, and a canonical sitemap", async () => {
    const article = {
      id: "article-1",
      author: { id: "author-1", nickname: "Justin", isOfficial: true },
      title: "从灵感到成稿",
      excerpt: "完整的 AI 小说创作流程。",
      body: "# 文章正文\n\n公开内容。",
      section: "tools",
      tags: ["平台指南"],
      kind: "article",
      publishedAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-10T12:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://agent.test/api/community/articles?kind=article&sort=latest&limit=100") {
        return new Response(JSON.stringify({ items: [article], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "http://agent.test/api/community/articles?kind=announcement&sort=latest&limit=100") {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "http://agent.test/api/community/articles/article-1") {
        return new Response(JSON.stringify({ article }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "http://agent.test/api/community/articles/missing") {
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input);
    }));

    await withServer(async (baseUrl) => {
      const headRes = await originalFetch(`${baseUrl}/community`, { method: "HEAD" });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-type")).toContain("text/html");

      const indexRes = await originalFetch(`${baseUrl}/community`);
      expect(indexRes.status).toBe(200);
      expect(indexRes.headers.get("content-type")).toContain("text/html");
      expect(await indexRes.text()).toContain('href="/community/article-1"');

      const detailRes = await originalFetch(`${baseUrl}/community/article-1`);
      expect(detailRes.status).toBe(200);
      expect(await detailRes.text()).toContain("文章正文");

      const englishDetailRes = await originalFetch(`${baseUrl}/community/article-1`, {
        headers: {
          cookie: "novel-vibe-locale=en",
          "accept-language": "zh-CN",
        },
      });
      expect(englishDetailRes.status).toBe(200);
      expect(englishDetailRes.headers.get("vary")).toContain("Cookie");
      expect(englishDetailRes.headers.get("cache-control")).toBe("private, max-age=60");
      const englishDetail = await englishDetailRes.text();
      expect(englishDetail).toContain('<html lang="en">');
      expect(englishDetail).toContain("AI Novel-Writing Community");
      expect(englishDetail).toContain("从灵感到成稿");
      expect(englishDetail).toContain("文章正文");
      expect(englishDetail).toContain('href="https://lingqiai.art/community/article-1"');

      expect((await originalFetch(`${baseUrl}/community/missing`)).status).toBe(404);

      const robotsRes = await originalFetch(`${baseUrl}/robots.txt`);
      expect(robotsRes.headers.get("content-type")).toContain("text/plain");
      expect(await robotsRes.text()).toContain("Sitemap: https://lingqiai.art/sitemap.xml");

      const sitemapRes = await originalFetch(`${baseUrl}/sitemap.xml`);
      expect(sitemapRes.headers.get("content-type")).toContain("application/xml");
      const sitemap = await sitemapRes.text();
      expect(sitemap).toContain("<loc>https://lingqiai.art/</loc>");
      expect(sitemap).toContain("https://lingqiai.art/community/article-1");

      const keyRes = await originalFetch(`${baseUrl}/12345678.txt`);
      expect(keyRes.headers.get("content-type")).toContain("text/plain");
      expect(await keyRes.text()).toBe("12345678");
      expect((await originalFetch(`${baseUrl}/wrong-key.txt`)).status).toBe(404);
    });
  });

  it("proxies community admin routes with the authenticated session token", async () => {
    const upstream: Array<{ url: string; method: string; auth: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "real-user", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("http://agent.test/api/community/")) {
        upstream.push({
          url,
          method: init?.method ?? "GET",
          auth: new Headers(init?.headers).get("authorization") ?? "",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      await originalFetch(`${baseUrl}/api/community/articles/a1/feature`, {
        method: "POST",
        headers: { cookie },
      });
      await originalFetch(`${baseUrl}/api/community/articles/a1/feedback-status`, {
        method: "PATCH",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackStatus: "planned", user_id: "attacker" }),
      });
    });

    expect(upstream[0]).toMatchObject({ method: "POST", body: undefined });
    expect(upstream[1].body).toEqual({ feedbackStatus: "planned" });
    expect(upstream.every((item) => item.auth.startsWith("Bearer "))).toBe(true);
  });

  it("preserves structured upstream errors for session routes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/sessions/session-1") {
        return new Response(JSON.stringify({
          error: "MEMORY_DELETE_UNAVAILABLE",
          message: "memory offline",
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/sessions/session-1`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "MEMORY_DELETE_UNAVAILABLE",
          message: "memory offline",
        },
      });
    });
  });

  it("streams chat events from the agent server", async () => {
    let upstreamAuth = "";
    let upstreamBody: any = null;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" },
          accessToken: "insforge-access-token",
          refreshToken: "insforge-refresh-token",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/chat") {
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        upstreamBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response('data: {"type":"turn_complete","turn_id":"turn-1","assistant_message_id":"reply-1"}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({
          project_id: "project-1",
          session_id: "session-1",
          interaction_response: {
            schemaVersion: 1,
            interactionId: "interaction-1",
            idempotencyKey: "key-1",
            answers: [],
            freeAnswer: "Continue quietly.",
          },
          user_id: "forged-user",
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(upstreamAuth).toBe("Bearer insforge-access-token");
      expect(upstreamBody).toMatchObject({
        project_id: "project-1",
        session_id: "session-1",
        interaction_response: expect.objectContaining({ interactionId: "interaction-1", freeAnswer: "Continue quietly." }),
        user_id: "user-1",
      });
      expect(upstreamBody.user_id).not.toBe("forged-user");
      await expect(res.text()).resolves.toBe('data: {"type":"turn_complete","turn_id":"turn-1","assistant_message_id":"reply-1"}\n\n');
    });
  });

  describe("chat stream upstream retry", () => {
    // Note: real timers here — fake timers interfere with the underlying Node
    // HTTP server's I/O scheduling. The BFF backoffs (300/800ms) keep the
    // whole suite well under a few seconds.

    // Shared fetch stub: login succeeds; agent /api/chat fails for the first
    // `failFirstN` calls then (optionally) streams a terminal event.
    function stubChatFetch(opts: {
      failFirstN: number;
      mode: "throw" | "500" | "401";
      successBody?: string;
    }) {
      const calls: Array<{ url: string; attempt: number }> = [];
      let chatCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("http://insforge.test/api/auth/sessions")) {
          return new Response(JSON.stringify({
            user: { id: "user-1", email: "u@example.com" },
            accessToken: "tok", refreshToken: "refresh",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url === "http://agent.test/api/chat") {
          chatCalls += 1;
          calls.push({ url, attempt: chatCalls });
          if (opts.mode === "401") {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401, headers: { "Content-Type": "application/json" },
            });
          }
          if (chatCalls <= opts.failFirstN) {
            if (opts.mode === "throw") throw new TypeError("fetch failed");
            return new Response(JSON.stringify({ error: "agent down" }), {
              status: 500, headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(
            opts.successBody ?? 'data: {"type":"turn_complete","turn_id":"t1","assistant_message_id":"a1"}\n\n',
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return originalFetch(input, init);
      }));
      return { calls: () => calls };
    }

    it("retries a transient upstream connection failure then streams successfully", async () => {
      const spy = stubChatFetch({ failFirstN: 1, mode: "throw" });

      await withServer(async (baseUrl) => {
        const cookie = await login(baseUrl);
        const res = await originalFetch(`${baseUrl}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ project_id: "p1", session_id: "s1", message: "hi" }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        expect(spy.calls().filter((c) => c.url === "http://agent.test/api/chat")).toHaveLength(2);
        await expect(res.text()).resolves.toContain("turn_complete");
      });
    });

    it("returns 502 when all upstream attempts fail at the network level", async () => {
      stubChatFetch({ failFirstN: 99, mode: "throw" });

      await withServer(async (baseUrl) => {
        const cookie = await login(baseUrl);
        const res = await originalFetch(`${baseUrl}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ project_id: "p1", session_id: "s1", message: "hi" }),
        });

        expect(res.status).toBe(502);
        await expect(res.json()).resolves.toEqual({
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "The service is temporarily unavailable",
          },
        });
      });
    });

    it("retries upstream 5xx responses then succeeds on a later attempt", async () => {
      const spy = stubChatFetch({ failFirstN: 2, mode: "500" });

      await withServer(async (baseUrl) => {
        const cookie = await login(baseUrl);
        const res = await originalFetch(`${baseUrl}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ project_id: "p1", session_id: "s1", message: "hi" }),
        });

        expect(res.status).toBe(200);
        expect(spy.calls().filter((c) => c.url === "http://agent.test/api/chat")).toHaveLength(3);
      });
    });

    it("does NOT retry upstream 401 — forwards it straight to the browser", async () => {
      const spy = stubChatFetch({ failFirstN: 0, mode: "401" });

      await withServer(async (baseUrl) => {
        const cookie = await login(baseUrl);
        const res = await originalFetch(`${baseUrl}/api/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ project_id: "p1", session_id: "s1", message: "hi" }),
        });

        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toEqual({
          error: {
            code: "UPSTREAM_ERROR",
            message: "The upstream service rejected the request",
          },
        });
      });
      // 401 must never be replayed — exactly one upstream hit.
      expect(spy.calls().filter((c) => c.url === "http://agent.test/api/chat")).toHaveLength(1);
    });
  });

  it("proxies reviewed Skill lifecycle routes with trusted identity", async () => {
    let upstreamBody: any;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://insforge.test/api/auth/sessions")) {
        return new Response(JSON.stringify({
          user: { id: "user-1", email: "u@example.com" }, accessToken: "token", refreshToken: "refresh",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "http://agent.test/api/skill-drafts") {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ draft: { id: "d1" } }), {
          status: 201, headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }));

    await withServer(async (baseUrl) => {
      const cookie = await login(baseUrl);
      const res = await originalFetch(`${baseUrl}/api/skill-drafts`, {
        method: "POST", headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ source: "paste", slug: "style", content: "body", roles: ["writer"], user_id: "forged" }),
      });
      expect(res.status).toBe(201);
      expect(upstreamBody.user_id).toBe("user-1");
    });
  });
});

describe("local-first mode routes", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const hostedConfig = {
    port: 0,
    insforgeUrl: "http://insforge.test",
    agentServerUrl: "http://agent.test",
    jwtSecret: "test-secret",
    cookieName: "novel_session",
    allowedOrigins: ["http://localhost:5173"],
    sessionTtlSeconds: 60,
    webuiDistDir: fileURLToPath(new URL("../../../webui-dist", import.meta.url)),
    localMode: false,
  };

  // No JWT_SECRET: the local BFF never signs or verifies a cookie.
  const localConfig = { ...hostedConfig, jwtSecret: "", localMode: true };

  async function withServer<T>(
    config: typeof hostedConfig,
    fn: (baseUrl: string) => Promise<T>,
  ): Promise<T> {
    const server = createServer(createHandler(config));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    try {
      return await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  }

  type FetchCall = { url: string; method: string; authorization: string | null; body: unknown };

  function stubAgent(): { calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "http://agent.test/api/chat") {
        return new Response("data: {}\n\n", {
          status: 200, headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.startsWith("http://agent.test/api/community/me/admin")) {
        return new Response(JSON.stringify({ isCommunityAdmin: false }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "http://agent.test/api/projects" && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ id: "project-1", title: "新书" }), {
          status: 201, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null, activeSessionId: null }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
    return { calls };
  }

  it("reports hosted mode and answers /api/mode without touching the agent server", async () => {
    const agent = stubAgent();

    await withServer(hostedConfig, async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/mode`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      await expect(res.json()).resolves.toEqual({ localMode: false });
    });

    expect(agent.calls).toHaveLength(0);
  });

  it("reports local mode from the BFF itself", async () => {
    const agent = stubAgent();

    await withServer(localConfig, async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/mode`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ localMode: true });
    });

    expect(agent.calls).toHaveLength(0);
  });

  it("returns the local identity for /api/me without a session cookie", async () => {
    const agent = stubAgent();

    await withServer(localConfig, async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/me`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "local@novel-vibe.local.invalid",
          isCommunityAdmin: false,
        },
      });
    });

    // Only the community-admin probe is allowed upstream; nothing authenticates.
    expect(agent.calls.map((call) => call.url)).toEqual(["http://agent.test/api/community/me/admin"]);
    expect(agent.calls[0].authorization).toBeNull();
  });

  it("accepts POST /api/auth locally without contacting InsForge", async () => {
    const agent = stubAgent();

    await withServer(localConfig, async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ email: "local@example.com", password: "x", mode: "login" }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      // No opaque cookie session is issued in local mode.
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    expect(agent.calls).toHaveLength(0);
  });

  it("forwards project routes for an anonymous local browser without an Authorization header", async () => {
    const agent = stubAgent();

    await withServer(localConfig, async (baseUrl) => {
      const list = await originalFetch(`${baseUrl}/api/projects`);
      expect(list.status).toBe(200);
      await expect(list.json()).resolves.toEqual({ items: [], nextCursor: null, activeSessionId: null });

      const created = await originalFetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ title: "新书", owner_id: "forged-user" }),
      });
      // The BFF returns the upstream payload with its own 200, exactly as the
      // hosted branch does.
      expect(created.status).toBe(200);
      await expect(created.json()).resolves.toEqual({ id: "project-1", title: "新书" });
    });

    expect(agent.calls).toHaveLength(2);
    // Trusted identity is stamped from the local session, never from the client.
    expect(agent.calls[0].url).toBe(
      "http://agent.test/api/projects?user_id=00000000-0000-4000-8000-000000000001",
    );
    expect(agent.calls[0].authorization).toBeNull();
    expect(agent.calls[1].url).toBe("http://agent.test/api/projects");
    expect(agent.calls[1].authorization).toBeNull();
    expect(agent.calls[1].body).toEqual({
      title: "新书",
      owner_id: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("forwards document and streaming chat routes without an Authorization header", async () => {
    const agent = stubAgent();

    await withServer(localConfig, async (baseUrl) => {
      const document = await originalFetch(`${baseUrl}/api/documents/p1/chapters/ch1.md`);
      expect(document.status).toBe(200);

      const chat = await originalFetch(`${baseUrl}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ project_id: "p1", session_id: "s1", message: "hi" }),
      });
      expect(chat.status).toBe(200);
      expect(chat.headers.get("content-type")).toContain("text/event-stream");
      await expect(chat.text()).resolves.toBe("data: {}\n\n");
    });

    const documentCall = agent.calls[0];
    expect(documentCall.url).toBe("http://agent.test/api/documents/p1/chapters/ch1.md");
    expect(documentCall.authorization).toBeNull();

    const chatCall = agent.calls[1];
    expect(chatCall.url).toBe("http://agent.test/api/chat");
    expect(chatCall.authorization).toBeNull();
    expect(chatCall.body).toEqual({
      project_id: "p1", session_id: "s1", message: "hi",
      user_id: "00000000-0000-4000-8000-000000000001",
    });
  });
});
