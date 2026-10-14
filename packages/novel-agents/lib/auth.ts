/**
 * Authentication helpers.
 *
 * The agent server sits behind the novel-web BFF, which forwards the user's
 * InsForge access token as the Bearer credential. That token is an HS256 JWT
 * signed with the shared JWT_SECRET, carrying `sub` = user id.
 *
 * We derive the authenticated user id by VERIFYING the token — never by
 * trusting a client-supplied `user_id` field. Request-scoped data clients
 * forward this same token to PostgREST so database RLS sees the same identity.
 *
 * The trust boundary is therefore a *shared secret plus a claim contract*, not
 * an InsForge-specific handshake. Any issuer — the BFF login flow, the MCP
 * delegated token, and a future local-first issuer — must produce HS256 tokens
 * signed with JWT_SECRET that carry BOTH a `sub` and a string `email` claim.
 * A token missing either claim is treated as unauthenticated (`deriveIdentity`
 * returns null), which surfaces as a 401 at the HTTP boundary. `auth.test.ts`
 * pins this contract.
 */
import { jwtVerify, SignJWT } from "jose";
import { createSecretKey } from "node:crypto";

/** The identity a verified access token asserts. */
export interface AuthenticatedIdentity {
  userId: string;
  email: string;
}

/**
 * Verify the access token and return the identity it asserts.
 * Returns null if the token is missing, malformed, expired, signed with the
 * wrong key, or missing the required `sub` / string `email` claims — callers
 * should treat null as "unauthenticated".
 */
export async function deriveIdentity(token: string): Promise<AuthenticatedIdentity | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(
      token,
      createSecretKey(Buffer.from(secret)),
      { algorithms: ["HS256"] },
    );
    return payload.sub && typeof payload.email === "string"
      ? { userId: String(payload.sub), email: payload.email }
      : null;
  } catch {
    return null;
  }
}

export interface DelegatedUserIdentity {
  userId: string;
  email?: string;
}

async function mintUserToken(identity: DelegatedUserIdentity, secret: string): Promise<string> {
  return new SignJWT({ email: identity.email, role: "authenticated" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(identity.userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(createSecretKey(Buffer.from(secret)));
}

/**
 * Mint the short-lived user JWT used after API-token authentication. API token
 * rows have no email, so an internal .invalid address supplies the claim that
 * InsForge identity derivation requires without exposing personal information.
 */
export async function mintDelegatedUserToken(identity: DelegatedUserIdentity): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required to mint a delegated user token");
  return mintUserToken({
    ...identity,
    email: identity.email ?? `${identity.userId}@internal.lingqiai.invalid`,
  }, secret);
}

/**
 * Mint a short-lived HS256 JWT for the given user id.
 *
 * Test-only helper (mirrors InsForge's TokenManager.generateAccessToken), so
 * server tests can authenticate requests with real, verifiable tokens instead
 * of opaque strings. Exported for use by the test suite.
 */
export async function signTestToken(userId: string, secret?: string): Promise<string> {
  return mintUserToken(
    { userId, email: `${userId}@example.com` },
    secret ?? process.env.JWT_SECRET ?? "test-secret",
  );
}
