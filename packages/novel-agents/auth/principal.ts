import type { ApiScope } from "./scopes.js";

interface PrincipalIdentity {
  userId: string;
  scopes: Set<ApiScope>;
}

export interface WebSessionPrincipal extends PrincipalIdentity {
  authType: "web_session";
  email?: string;
  tokenId?: never;
}

export interface ApiTokenPrincipal extends PrincipalIdentity {
  authType: "api_token";
  tokenId: string;
}

export type AuthPrincipal = WebSessionPrincipal | ApiTokenPrincipal;
