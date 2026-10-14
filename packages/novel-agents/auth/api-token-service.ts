import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ApiTokenRepository,
  ApiTokenSummary,
  InsertApiTokenInput,
} from "./api-token-repository.js";
import type { AuthPrincipal } from "./principal.js";
import { API_SCOPES, type ApiScope } from "./scopes.js";

export type ApiTokenLifetimeDays = 30 | 90 | 365;

export interface CreateApiTokenInput {
  ownerId: string;
  name: string;
  scopes: ApiScope[];
  lifetimeDays: ApiTokenLifetimeDays;
}

export type CreatedApiToken = ApiTokenSummary & { token: string };

export interface ApiTokenServiceOptions {
  now?: () => Date;
  onTouchError?: (error: unknown) => void;
}

type TokenRepository = Pick<
  ApiTokenRepository,
  "insert" | "listByOwner" | "findActiveByPublicId" | "revokeOwned" | "touchLastUsed"
>;

const TOKEN_PATTERN = /^lingqi_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/;
const VALID_LIFETIMES = new Set<number>([30, 90, 365]);
const ONE_HOUR_MS = 60 * 60 * 1000;

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function storedHash(value: string): Buffer {
  return /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.alloc(32);
}

function isDelegableScope(value: unknown): value is ApiScope {
  return typeof value === "string"
    && Object.hasOwn(API_SCOPES, value)
    && API_SCOPES[value as ApiScope].delegable;
}

function safeSummary(row: Awaited<ReturnType<TokenRepository["insert"]>>): ApiTokenSummary {
  const { secret_hash: _secretHash, ...summary } = row;
  return summary;
}

export class ApiTokenService {
  private readonly now: () => Date;
  private readonly onTouchError: (error: unknown) => void;

  constructor(
    private readonly repository: TokenRepository,
    options: ApiTokenServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onTouchError = options.onTouchError ?? (() => {});
  }

  async create(input: CreateApiTokenInput): Promise<CreatedApiToken> {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new Error("Token name must be between 1 and 100 characters");
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new Error("At least one scope is required");
    }
    if (!input.scopes.every(isDelegableScope)) throw new Error("All scopes must be known and delegable");
    if (!VALID_LIFETIMES.has(input.lifetimeDays)) {
      throw new Error("Token lifetime must be 30, 90, or 365 days");
    }

    const publicId = randomBytes(12).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + input.lifetimeDays * 24 * 60 * 60 * 1000);
    const insert: InsertApiTokenInput = {
      publicId,
      secretHash: hashSecret(secret).toString("hex"),
      ownerId: input.ownerId,
      name,
      scopes: [...new Set(input.scopes)],
      expiresAt: expiresAt.toISOString(),
    };
    const row = await this.repository.insert(insert);
    return { ...safeSummary(row), token: `lingqi_${publicId}_${secret}` };
  }

  list(ownerId: string): Promise<ApiTokenSummary[]> {
    return this.repository.listByOwner(ownerId);
  }

  revoke(tokenId: string, ownerId: string): Promise<boolean> {
    return this.repository.revokeOwned(tokenId, ownerId, this.now().toISOString());
  }

  async authenticate(token: string): Promise<AuthPrincipal | null> {
    const parsed = TOKEN_PATTERN.exec(token);
    if (!parsed) return null;
    const [, publicId, secret] = parsed;
    const now = this.now();
    const row = await this.repository.findActiveByPublicId(publicId!, now.toISOString());
    if (!row) return null;

    const presented = hashSecret(secret!);
    const matches = timingSafeEqual(presented, storedHash(row.secret_hash));
    const expiresAt = Date.parse(row.expires_at);
    if (!matches || row.revoked_at !== null || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      return null;
    }
    if (!Array.isArray(row.scopes) || !row.scopes.every(isDelegableScope)) return null;

    const cutoff = new Date(now.getTime() - ONE_HOUR_MS);
    const lastUsedAt = row.last_used_at === null ? Number.NEGATIVE_INFINITY : Date.parse(row.last_used_at);
    if (!Number.isFinite(lastUsedAt) || lastUsedAt <= cutoff.getTime()) {
      try {
        await this.repository.touchLastUsed(row.id, now.toISOString(), cutoff.toISOString());
      } catch (error) {
        try {
          this.onTouchError(error);
        } catch {
          // Observability must not turn best-effort maintenance into an auth failure.
        }
      }
    }

    return {
      userId: row.user_id,
      authType: "api_token",
      scopes: new Set(row.scopes),
      tokenId: row.id,
    };
  }
}
