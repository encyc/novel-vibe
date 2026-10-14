import { describe, expect, expectTypeOf, it } from "vitest";
import type { AuthPrincipal } from "./principal.js";
import type { ApiScope } from "./scopes.js";

describe("AuthPrincipal", () => {
  it("discriminates web sessions from scoped API tokens", () => {
    type WebSessionPrincipal = Extract<AuthPrincipal, { authType: "web_session" }>;
    type ApiTokenPrincipal = Extract<AuthPrincipal, { authType: "api_token" }>;

    expectTypeOf<WebSessionPrincipal>().toMatchTypeOf<{
      userId: string;
      authType: "web_session";
      scopes: Set<ApiScope>;
      email?: string;
      tokenId?: never;
    }>();
    expectTypeOf<WebSessionPrincipal>().not.toHaveProperty("accessToken");
    expectTypeOf<ApiTokenPrincipal>().toMatchTypeOf<{
      userId: string;
      authType: "api_token";
      tokenId: string;
      scopes: Set<ApiScope>;
    }>();

    const principals: AuthPrincipal[] = [
      {
        userId: "web-user",
        authType: "web_session",
        scopes: new Set(["tokens:manage"]),
        email: "user@example.com",
      },
      {
        userId: "api-user",
        authType: "api_token",
        tokenId: "token-id",
        scopes: new Set(["projects:read"]),
      },
    ];
    expect(principals.map((principal) => principal.authType)).toEqual(["web_session", "api_token"]);
  });
});
