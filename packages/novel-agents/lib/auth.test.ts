import { createSecretKey } from "node:crypto";
import { SignJWT, decodeJwt, decodeProtectedHeader } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveIdentity, mintDelegatedUserToken, signTestToken } from "./auth.js";

let previousJwtSecret: string | undefined;

beforeEach(() => {
  previousJwtSecret = process.env.JWT_SECRET;
});

afterEach(() => {
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

/** Sign arbitrary claims so the identity contract can be probed claim by claim. */
async function signRawToken(claims: Record<string, unknown>, secret: string, expiresAt?: number): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt();
  if (expiresAt !== undefined) jwt.setExpirationTime(expiresAt);
  return jwt.sign(createSecretKey(Buffer.from(secret)));
}

describe("deriveIdentity", () => {
  it("returns verified user and email claims", async () => {
    process.env.JWT_SECRET = "identity-test-secret";
    const token = await signTestToken("user-1");
    await expect(deriveIdentity(token)).resolves.toEqual({ userId: "user-1", email: "user-1@example.com" });
  });

  it("rejects invalid signatures", async () => {
    process.env.JWT_SECRET = "identity-test-secret";
    const token = await signTestToken("user-1", "different-secret");
    await expect(deriveIdentity(token)).resolves.toBeNull();
  });

  // The identity contract is a shared secret, not an InsForge-specific
  // handshake: any issuer (BFF login, MCP delegated token, and a future
  // local-first issuer) must supply BOTH `sub` and a string `email`, or the
  // request is treated as unauthenticated. These lock that down so a new
  // issuer cannot silently produce always-401 tokens.
  it("rejects a correctly signed token that is missing the email claim", async () => {
    process.env.JWT_SECRET = "identity-test-secret";
    const token = await signRawToken({ sub: "user-1" }, "identity-test-secret");
    await expect(deriveIdentity(token)).resolves.toBeNull();
  });

  it("rejects a correctly signed token that is missing the sub claim", async () => {
    process.env.JWT_SECRET = "identity-test-secret";
    const token = await signRawToken({ email: "user-1@example.com" }, "identity-test-secret");
    await expect(deriveIdentity(token)).resolves.toBeNull();
  });

  it("rejects a correctly signed token whose email claim is not a string", async () => {
    process.env.JWT_SECRET = "identity-test-secret";
    const token = await signRawToken({ sub: "user-1", email: { id: "user-1" } }, "identity-test-secret");
    await expect(deriveIdentity(token)).resolves.toBeNull();
  });

  it("rejects an expired token even when the signature and claims are valid", async () => {
    process.env.JWT_SECRET = "identity-test-secret";
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    const token = await signRawToken(
      { sub: "user-1", email: "user-1@example.com", exp: expiredAt },
      "identity-test-secret",
      expiredAt,
    );
    await expect(deriveIdentity(token)).resolves.toBeNull();
  });

  it("returns null when no signing secret is configured", async () => {
    delete process.env.JWT_SECRET;
    const token = await signRawToken({ sub: "user-1", email: "user-1@example.com" }, "identity-test-secret");
    await expect(deriveIdentity(token)).resolves.toBeNull();
  });
});

describe("mintDelegatedUserToken", () => {
  it("mints an HS256 authenticated JWT with a stable internal email and 15-minute expiry", async () => {
    process.env.JWT_SECRET = "delegation-test-secret";
    const token = await mintDelegatedUserToken({ userId: "user-1", authType: "api_token" });
    const payload = decodeJwt(token);

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({
      sub: "user-1",
      email: "user-1@internal.lingqiai.invalid",
      role: "authenticated",
    });
    expect(payload.exp! - payload.iat!).toBe(15 * 60);
    await expect(deriveIdentity(token)).resolves.toEqual({
      userId: "user-1",
      email: "user-1@internal.lingqiai.invalid",
    });
  });

  it("requires the production signing secret", async () => {
    delete process.env.JWT_SECRET;
    await expect(mintDelegatedUserToken({ userId: "user-1", authType: "api_token" }))
      .rejects.toThrow("JWT_SECRET");
  });
});
