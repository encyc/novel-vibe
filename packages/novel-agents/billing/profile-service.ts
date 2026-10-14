import { randomUUID } from "node:crypto";
import type { DbClient, UserProfileRow } from "../lib/db.js";
import { isSupportedLanguage, type SupportedLanguage } from "../lib/language.js";
import type { ContentStore } from "../lib/content-store.js";

export class ProfileInputError extends Error {
  readonly status = 400;
  constructor(
    readonly code: "INVALID_PROFILE_INPUT" | "INVALID_PROFILE_LOCALE",
    message: string,
  ) {
    super(message);
  }
}

export interface ProfileView {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  locale: SupportedLanguage;
}

const avatarTypes = {
  "image/jpeg": { extension: "jpg", matches: (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/png": { extension: "png", matches: (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { extension: "webp", matches: (bytes: Buffer) => bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" },
} as const;

const DEFAULT_DISPLAY_NAME = "灵器用户";

export class ProfileService {
  constructor(
    private readonly db: Pick<DbClient, "getUserProfile" | "upsertUserProfile">,
    private readonly storage: Pick<ContentStore, "writeBytes" | "delete" | "publicUrl">,
  ) {}

  async getProfile(userId: string, email: string, initialLocale: SupportedLanguage): Promise<ProfileView> {
    const existing = await this.db.getUserProfile(userId);
    if (existing?.locale) return this.view(existing, email);
    const row = await this.db.upsertUserProfile({
      userId,
      nickname: existing?.nickname ?? null,
      avatarUrl: existing?.avatar_url ?? null,
      locale: initialLocale,
    });
    return this.view(row, email);
  }

  async updateProfile(
    userId: string,
    email: string,
    input: { displayName?: string; locale?: SupportedLanguage },
  ): Promise<ProfileView> {
    if (input.locale !== undefined && !isSupportedLanguage(input.locale)) {
      throw new ProfileInputError("INVALID_PROFILE_LOCALE", "Unsupported interface locale");
    }
    const current = await this.db.getUserProfile(userId);
    const nickname = input.displayName === undefined
      ? current?.nickname ?? null
      : validateDisplayName(input.displayName);
    const locale = input.locale ?? current?.locale ?? "zh-CN";
    const row = await this.db.upsertUserProfile({
      userId,
      nickname,
      avatarUrl: current?.avatar_url ?? null,
      locale,
    });
    return this.view(row, email);
  }

  async updateAvatar(userId: string, email: string, mime: string, bytes: Buffer): Promise<ProfileView> {
    if (bytes.length > 2 * 1024 * 1024) throw new ProfileInputError("INVALID_PROFILE_INPUT", "头像不能超过 2MB");
    const type = avatarTypes[mime as keyof typeof avatarTypes];
    if (!type || !type.matches(bytes)) throw new ProfileInputError("INVALID_PROFILE_INPUT", "头像必须是有效的 JPEG、PNG 或 WebP 图片");

    const current = await this.db.getUserProfile(userId);
    const path = `${userId}/${randomUUID()}.${type.extension}`;
    await this.storage.writeBytes(path, bytes, mime);
    const avatarUrl = this.storage.publicUrl(path);
    try {
      const row = await this.db.upsertUserProfile({
        userId,
        nickname: current?.nickname?.trim() || DEFAULT_DISPLAY_NAME,
        avatarUrl,
        locale: current?.locale ?? "zh-CN",
      });
      return this.view(row, email);
    } catch (error) {
      await this.storage.delete(path).catch(() => undefined);
      throw error;
    }
  }

  private view(row: UserProfileRow, email: string): ProfileView {
    return {
      id: row.id,
      email,
      displayName: row.nickname?.trim() || DEFAULT_DISPLAY_NAME,
      avatarUrl: row.avatar_url,
      locale: row.locale ?? "zh-CN",
    };
  }
}

function validateDisplayName(value: string): string {
  const displayName = value.trim();
  if ([...displayName].length < 1 || [...displayName].length > 40) {
    throw new ProfileInputError("INVALID_PROFILE_INPUT", "昵称长度必须为 1–40 个字符");
  }
  return displayName;
}
