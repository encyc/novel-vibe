import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export interface WebSession {
  id: string;
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  expiresAt: number;
}

export type TokenRefresher = (refreshToken: string) => Promise<Pick<WebSession, "accessToken" | "refreshToken" | "accessTokenExpiresAt">>;

export interface SessionStoreLimits {
  cleanupIntervalMs: number;
  maxSessions: number;
  maxSessionsPerUser: number;
}

const DEFAULT_LIMITS: SessionStoreLimits = {
  cleanupIntervalMs: 60_000,
  maxSessions: 10_000,
  maxSessionsPerUser: 20,
};

export class SessionStore {
  private sessions = new Map<string, WebSession>();
  private refreshes = new Map<string, Promise<WebSession | null>>();
  private readonly limits: SessionStoreLimits;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
    private readonly refreshTokens?: TokenRefresher,
    private readonly refreshLeewaySeconds = 30,
    limits: Partial<SessionStoreLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (this.limits.cleanupIntervalMs <= 0
        || this.limits.maxSessions <= 0
        || this.limits.maxSessionsPerUser <= 0) {
      throw new Error("Session store limits must be positive");
    }
    this.cleanupTimer = setInterval(() => this.pruneExpired(), this.limits.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
  }

  async create(input: Omit<WebSession, "id" | "expiresAt">): Promise<{ session: WebSession; cookieValue: string }> {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.pruneExpired(now);
    const session: WebSession = { ...input, id, expiresAt: now + this.ttlSeconds };
    this.sessions.set(id, session);
    this.enforceCapacity(session.userId);

    const cookieValue = await new SignJWT({ sid: id })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(session.expiresAt)
      .sign(new TextEncoder().encode(this.secret));

    return { session, cookieValue };
  }

  async get(cookieValue: string | undefined): Promise<WebSession | null> {
    if (!cookieValue) return null;
    try {
      const { payload } = await jwtVerify(cookieValue, new TextEncoder().encode(this.secret), { algorithms: ["HS256"] });
      const sid = typeof payload.sid === "string" ? payload.sid : "";
      const session = this.sessions.get(sid);
      if (!session) return null;
      if (session.expiresAt <= Math.floor(Date.now() / 1000)) {
        this.remove(sid);
        return null;
      }
      if (!this.refreshTokens || session.accessTokenExpiresAt > Math.floor(Date.now() / 1000) + this.refreshLeewaySeconds) {
        return session;
      }
      return await this.refresh(sid, session);
    } catch {
      return null;
    }
  }

  private refresh(sid: string, session: WebSession): Promise<WebSession | null> {
    const existing = this.refreshes.get(sid);
    if (existing) return existing;

    const pending = this.refreshTokens!(session.refreshToken)
      .then((tokens) => {
        const current = this.sessions.get(sid);
        if (!current) return null;
        const refreshed = { ...current, ...tokens };
        this.sessions.set(sid, refreshed);
        return refreshed;
      })
      .catch(() => {
        this.remove(sid);
        return null;
      })
      .finally(() => {
        this.refreshes.delete(sid);
      });
    this.refreshes.set(sid, pending);
    return pending;
  }

  async delete(cookieValue: string | undefined): Promise<void> {
    if (!cookieValue) return;
    try {
      const { payload } = await jwtVerify(cookieValue, new TextEncoder().encode(this.secret), { algorithms: ["HS256"] });
      if (typeof payload.sid === "string") this.remove(payload.sid);
    } catch {
      // Invalid cookies are already effectively logged out.
    }
  }

  private pruneExpired(now = Math.floor(Date.now() / 1000)): void {
    for (const [sid, session] of this.sessions) {
      if (session.expiresAt <= now) this.remove(sid);
    }
  }

  private enforceCapacity(userId: string): void {
    let userCount = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) userCount += 1;
    }
    for (const [sid, session] of this.sessions) {
      if (userCount <= this.limits.maxSessionsPerUser) break;
      if (session.userId === userId) {
        this.remove(sid);
        userCount -= 1;
      }
    }
    while (this.sessions.size > this.limits.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.remove(oldest);
    }
  }

  private remove(sid: string): void {
    this.sessions.delete(sid);
    this.refreshes.delete(sid);
  }
}
