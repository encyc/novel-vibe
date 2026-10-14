export interface WebConfig {
  port: number;
  insforgeUrl: string;
  agentServerUrl: string;
  jwtSecret: string;
  cookieName: string;
  cookieDomain?: string;
  allowedOrigins: string[];
  sessionTtlSeconds: number;
  webuiDistDir: string;
  indexNowKey?: string;
  /**
   * True when the BFF runs the local-first profile: a transparent proxy in front
   * of the agent server with no sign-in step. See {@link isLocalModeEnabled}.
   */
  localMode: boolean;
}

/** Environment flag that selects local-first mode. */
export const LOCAL_MODE_ENV = "NOVEL_VIBE_LOCAL_MODE";

/**
 * Identity a local install acts as.
 *
 * These mirror `LOCAL_USER_ID` / `LOCAL_USER_EMAIL` in
 * `packages/novel-agents/lib/local-mode.ts`. The BFF cannot import that module
 * (the web package does not depend on the agent package), and the pair is a
 * stable contract value rather than a tunable: the agent server mints exactly
 * this identity for a request that arrives without a Bearer token, so the
 * `user_id` the BFF stamps onto forwarded requests can never disagree with the
 * identity the agent server derives, which is why the value is duplicated here
 * instead of being probed at runtime. Changing one side without the other is a
 * bug.
 */
export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_USER_EMAIL = "local@novel-vibe.local.invalid";

/**
 * Read the local-first flag.
 *
 * Kept byte-for-byte compatible with `isLocalMode()` in
 * `packages/novel-agents/lib/local-mode.ts` (`1/true/yes/on`, case-insensitive,
 * trimmed) so the two processes cannot disagree about which profile they run.
 */
export function isLocalModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LOCAL_MODE_ENV];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function loadConfig(env = process.env): WebConfig {
  const localMode = isLocalModeEnabled(env);

  // In hosted mode JWT_SECRET signs the opaque cookie session, so a missing
  // secret is a hard startup failure. Local mode never creates a cookie session
  // (there is no sign-in to persist) and forwards nothing signed, so the BFF can
  // start without it. The agent server still needs JWT_SECRET to mint the local
  // identity — that requirement is enforced there, not weakened here.
  const jwtSecret = env.JWT_SECRET ?? "";
  if (!jwtSecret && !localMode) throw new Error("JWT_SECRET env var is required");

  const configuredAllowedOrigins = (env.NOVEL_VIBE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedOrigins = configuredAllowedOrigins.length > 0 || env.NODE_ENV === "production"
    ? configuredAllowedOrigins
    : ["http://localhost:5173", "http://127.0.0.1:5173"];

  return {
    port: Number.parseInt(env.NOVEL_VIBE_WEB_PORT ?? "9120", 10),
    insforgeUrl: env.INSFORGE_URL ?? "http://localhost:7130",
    agentServerUrl: env.NOVEL_VIBE_AGENT_URL ?? "http://localhost:7140",
    jwtSecret,
    cookieName: env.NOVEL_VIBE_SESSION_COOKIE ?? "novel_session",
    cookieDomain: env.NOVEL_VIBE_SESSION_COOKIE_DOMAIN?.trim() || undefined,
    allowedOrigins,
    sessionTtlSeconds: Number.parseInt(env.NOVEL_VIBE_SESSION_TTL_SECONDS ?? "86400", 10),
    webuiDistDir: env.WEBUI_DIST_DIR ?? "webui-dist",
    indexNowKey: env.INDEXNOW_KEY?.trim() || undefined,
    localMode,
  };
}
