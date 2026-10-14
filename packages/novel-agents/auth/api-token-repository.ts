import type { DbClient } from "../lib/db.js";
import type { ApiScope } from "./scopes.js";

export interface ApiTokenRow {
  id: string;
  public_id: string;
  secret_hash: string;
  user_id: string;
  name: string;
  scopes: ApiScope[];
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type ApiTokenSummary = Omit<ApiTokenRow, "secret_hash">;

export interface InsertApiTokenInput {
  publicId: string;
  secretHash: string;
  ownerId: string;
  name: string;
  scopes: ApiScope[];
  expiresAt: string;
}

export interface ApiTokenRepositoryOptions {
  postgrestUrl?: string;
}

const OWNER_SAFE_COLUMNS = [
  "id",
  "public_id",
  "user_id",
  "name",
  "scopes",
  "expires_at",
  "last_used_at",
  "revoked_at",
  "created_at",
].join(",");

function encode(value: string): string {
  return encodeURIComponent(value);
}

function omitSecretHash(row: ApiTokenRow): ApiTokenSummary {
  const { secret_hash: _secretHash, ...safe } = row;
  return safe;
}

/**
 * System-only PostgREST adapter for API token persistence. Accessing pgToken
 * rejects user-scoped DbClient instances. Token management remains exposed
 * only through Web-session-authenticated application routes.
 */
export class ApiTokenRepository {
  private readonly postgrestUrl: string;

  constructor(
    private readonly db: DbClient,
    options: ApiTokenRepositoryOptions = {},
  ) {
    this.postgrestUrl = options.postgrestUrl
      ?? process.env.POSTGREST_URL
      ?? "http://localhost:5430";
  }

  private headers(write = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.db.pgToken}`,
      "Content-Type": "application/json",
      "Accept-Profile": "novel",
      ...(write ? { "Content-Profile": "novel" } : {}),
    };
  }

  private async rows<T>(res: Response, operation: string): Promise<T[]> {
    if (!res.ok) {
      throw new Error(`${operation} failed [${res.status}]: ${await res.text()}`);
    }
    return res.json() as Promise<T[]>;
  }

  async insert(input: InsertApiTokenInput): Promise<ApiTokenRow> {
    const res = await fetch(`${this.postgrestUrl}/api_tokens`, {
      method: "POST",
      headers: { ...this.headers(true), Prefer: "return=representation" },
      body: JSON.stringify({
        public_id: input.publicId,
        secret_hash: input.secretHash,
        user_id: input.ownerId,
        name: input.name,
        scopes: input.scopes,
        expires_at: input.expiresAt,
      }),
    });
    const rows = await this.rows<ApiTokenRow>(res, "Insert API token");
    const row = rows[0];
    if (!row) throw new Error("Insert API token returned no row");
    return row;
  }

  async listByOwner(ownerId: string): Promise<ApiTokenSummary[]> {
    const url = `${this.postgrestUrl}/api_tokens?user_id=eq.${encode(ownerId)}`
      + `&select=${encode(OWNER_SAFE_COLUMNS)}&order=created_at.desc`;
    const rows = await this.rows<ApiTokenRow>(
      await fetch(url, { headers: this.headers() }),
      "List API tokens",
    );
    return rows.map(omitSecretHash);
  }

  /** Returns only a non-revoked row whose expiry is later than activeAt. */
  async findActiveByPublicId(publicId: string, activeAt: string): Promise<ApiTokenRow | null> {
    const url = `${this.postgrestUrl}/api_tokens?public_id=eq.${encode(publicId)}`
      + `&revoked_at=is.null&expires_at=gt.${encode(activeAt)}&limit=1`;
    const rows = await this.rows<ApiTokenRow>(
      await fetch(url, { headers: this.headers() }),
      "Find active API token",
    );
    return rows[0] ?? null;
  }

  async revokeOwned(tokenId: string, ownerId: string, revokedAt: string): Promise<boolean> {
    const url = `${this.postgrestUrl}/api_tokens?id=eq.${encode(tokenId)}`
      + `&user_id=eq.${encode(ownerId)}&revoked_at=is.null&select=id`;
    const rows = await this.rows<{ id: string }>(await fetch(url, {
      method: "PATCH",
      headers: { ...this.headers(true), Prefer: "return=representation" },
      body: JSON.stringify({ revoked_at: revokedAt }),
    }), "Revoke API token");
    return rows.length > 0;
  }

  async touchLastUsed(tokenId: string, usedAt: string, cutoff: string): Promise<boolean> {
    const stale = `last_used_at.is.null,last_used_at.lt.${cutoff}`;
    const url = `${this.postgrestUrl}/api_tokens?id=eq.${encode(tokenId)}`
      + `&revoked_at=is.null&expires_at=gt.${encode(usedAt)}`
      + `&or=(${encode(stale)})&select=id`;
    const rows = await this.rows<{ id: string }>(await fetch(url, {
      method: "PATCH",
      headers: { ...this.headers(true), Prefer: "return=representation" },
      body: JSON.stringify({ last_used_at: usedAt }),
    }), "Touch API token last use");
    return rows.length > 0;
  }
}
