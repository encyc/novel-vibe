/**
 * Local-first mode.
 *
 * In local mode the application runs on the user's own machine for a single
 * person, so there is no sign-in step and no author-operated service in the path.
 * What there *is* is the same storage and database the hosted deployment uses —
 * ADR 0007 keeps PostgreSQL rather than porting to SQLite — which means the
 * existing RLS policies and the `novel.projects.owner_id -> auth.users(id)`
 * foreign key still apply.
 *
 * So "no login" does not mean "no identity". It means the identity is *minted
 * locally* instead of obtained from an authorization server:
 *
 *   1. one fixed local user id, so every row this install creates has a stable owner;
 *   2. a row for that user in `auth.users`, created on first start (the FK requires it);
 *   3. a short-lived HS256 token minted from `JWT_SECRET` — the same mechanism the
 *      MCP adapter already uses — so `DbClient.forUser` and PostgREST see a normal
 *      authenticated request and RLS keeps working unchanged.
 *
 * This deliberately keeps one code path rather than adding a privileged one: local
 * mode is not "the app with authorization switched off", it is "the app with the
 * sign-in step replaced by a local issuer".
 */

/** Environment flag that selects local-first mode. */
export const LOCAL_MODE_ENV = "NOVEL_VIBE_LOCAL_MODE";

/**
 * Stable owner id for everything a local install creates.
 *
 * A fixed literal rather than a random per-install value: the id appears in
 * project directories, RLS predicates and exported data, and a stable value keeps
 * a vault readable across reinstalls. It is a valid v4-shaped UUID.
 */
export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";

/** Address used for the local user. `.invalid` is reserved by RFC 2606 and never resolvable. */
export const LOCAL_USER_EMAIL = "local@novel-vibe.local.invalid";

export function isLocalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LOCAL_MODE_ENV];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** The identity a local install acts as. */
export interface LocalIdentity {
  userId: string;
  email: string;
}

export const LOCAL_IDENTITY: LocalIdentity = Object.freeze({
  userId: LOCAL_USER_ID,
  email: LOCAL_USER_EMAIL,
});
