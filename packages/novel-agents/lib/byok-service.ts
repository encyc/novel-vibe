import { BYOK_ALLOWED_PROVIDERS, BYOK_PROVIDER_LABELS, byokEncryptionConfigured } from "./byok.js";
import { decryptByokSecret, encryptByokSecret } from "./crypto.js";
import type { DbClient } from "./db.js";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

/** Domain error carrying an HTTP status for route handlers. */
export class ByokKeyServiceError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ByokKeyServiceError";
  }
}

const MIN_API_KEY_LENGTH = 8;

export interface ByokProviderModelInfo {
  id: string;
  name: string;
  contextWindow: number;
}

export interface ByokProviderConfig {
  id: string;
  label: string;
  models: ByokProviderModelInfo[];
}

export interface ByokConfig {
  enabled: boolean;
  providers: ByokProviderConfig[];
}

export class ByokKeyService {
  constructor(private db: DbClient) {}

  private requireEncryption(): void {
    if (!byokEncryptionConfigured()) {
      throw new ByokKeyServiceError(409, "自带模型密钥功能暂未开放。");
    }
  }

  async list(userId: string): Promise<Array<{ provider: string; keyLast4: string; updatedAt: string }>> {
    const rows = await this.db.listActiveUserLlmKeys(userId);
    return rows.map((row: any) => ({
      provider: String(row.provider),
      keyLast4: String(row.key_last4),
      updatedAt: String(row.updated_at),
    }));
  }

  async save(userId: string, provider: string, apiKey: string): Promise<{ provider: string; keyLast4: string; updatedAt: string }> {
    this.requireEncryption();
    if (!(BYOK_ALLOWED_PROVIDERS as readonly string[]).includes(provider)) {
      throw new ByokKeyServiceError(400, "不支持的平台。");
    }
    const trimmed = apiKey.trim();
    // Format pre-flight only: an invalid key surfaces as a provider 401 on
    // first use, which chat error classification reports to the user.
    if (trimmed.length < MIN_API_KEY_LENGTH || !/^[\x21-\x7E]+$/.test(trimmed)) {
      throw new ByokKeyServiceError(400, "API Key 格式无效。");
    }
    const row = await this.db.upsertUserLlmKey({
      userId,
      provider,
      encryptedKey: encryptByokSecret(trimmed),
      keyLast4: trimmed.slice(-4),
    });
    return { provider, keyLast4: String(row.key_last4), updatedAt: String(row.updated_at) };
  }

  async revoke(userId: string, provider: string): Promise<{ revoked: boolean }> {
    return { revoked: await this.db.revokeUserLlmKey(userId, provider) };
  }

  async resolveKey(userId: string, provider: string): Promise<string> {
    const row = await this.db.findActiveUserLlmKey(userId, provider);
    if (!row) throw new ByokKeyServiceError(404, "尚未配置该平台的 API Key。");
    return decryptByokSecret(String(row.encrypted_key));
  }

  /** Provider metadata + builtin model catalogs for the WebUI selector. */
  async config(): Promise<ByokConfig> {
    if (!byokEncryptionConfigured()) return { enabled: false, providers: [] };
    const providers = BYOK_ALLOWED_PROVIDERS.map((id) => {
      let models: ByokProviderModelInfo[] = [];
      try {
        models = (getBuiltinModels(id as never) as any[])
          .filter((model) => model.api !== "google-vertex") // Vertex needs service-level credentials, not user keys.
          .map((model) => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
          }));
      } catch {
        models = [];
      }
      return { id, label: BYOK_PROVIDER_LABELS[id] ?? id, models };
    }).filter((provider) => provider.models.length > 0);
    return { enabled: true, providers };
  }
}
