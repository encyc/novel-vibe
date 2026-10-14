import { ApiTokenRepository } from "../../novel-agents/auth/api-token-repository.js";
import { ApiTokenService } from "../../novel-agents/auth/api-token-service.js";
import { mintDelegatedUserToken } from "../../novel-agents/lib/auth.js";
import { DbClient } from "../../novel-agents/lib/db.js";
import type { ApiScope } from "../../novel-agents/auth/scopes.js";

export class McpAuthenticator {
  constructor(private readonly service = new ApiTokenService(new ApiTokenRepository(DbClient.forSystem()))) {}

  async authenticate(header: string | undefined) {
    if (!header?.startsWith("Bearer ")) return null;
    const principal = await this.service.authenticate(header.slice(7).trim());
    if (!principal || principal.authType !== "api_token") return null;
    const delegatedToken = await mintDelegatedUserToken({ userId: principal.userId });
    return { principal, delegatedToken };
  }
}

export function requireScopes(granted: ReadonlySet<ApiScope>, required: readonly ApiScope[]): void {
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length) throw new Error(`SCOPE_REQUIRED: ${missing.join(", ")}`);
}
