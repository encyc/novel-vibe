import { describe, expect, it, vi } from "vitest";
import { ProfileService } from "./billing/profile-service.js";

function setup(row: any = { id: "user-1", nickname: "旧名", avatar_url: null, locale: "zh-CN" }) {
  const db = {
    getUserProfile: vi.fn().mockResolvedValue(row),
    upsertUserProfile: vi.fn().mockImplementation(async ({ userId, nickname, avatarUrl, locale }) => ({
      id: userId, nickname, avatar_url: avatarUrl, locale,
    })),
  };
  const storage = {
    writeBytes: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    publicUrl: vi.fn((path: string) => `https://files.test/avatars/${path}`),
  };
  return { db, storage, service: new ProfileService(db as any, storage as any) };
}

describe("ProfileService", () => {
  it("trims and saves a valid display name", async () => {
    const { db, service } = setup();
    const result = await service.updateProfile("user-1", "u@example.com", { displayName: "  墨白  " });
    expect(db.upsertUserProfile).toHaveBeenCalledWith({ userId: "user-1", nickname: "墨白", avatarUrl: null, locale: "zh-CN" });
    expect(result.displayName).toBe("墨白");
  });

  it.each(["", "x".repeat(41)])("rejects invalid display name", async (displayName) => {
    const { service } = setup();
    await expect(service.updateProfile("user-1", "u@example.com", { displayName }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("does not expose the email prefix when a profile is missing", async () => {
    const { db, service } = setup(null);
    await expect(service.getProfile("user-1", "writer@example.com", "zh-CN"))
      .resolves.toMatchObject({ displayName: "灵器用户", email: "writer@example.com" });
    expect(db.upsertUserProfile).not.toHaveBeenCalledWith(expect.objectContaining({ nickname: "writer" }));
  });

  it("keeps a non-identifying display name when uploading an avatar before setting a nickname", async () => {
    const { db, service } = setup({ id: "user-1", nickname: null, avatar_url: null, locale: "zh-CN" });

    await service.updateAvatar("user-1", "writer@example.com", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    expect(db.upsertUserProfile).toHaveBeenCalledWith(expect.objectContaining({
      nickname: "灵器用户",
      locale: "zh-CN",
    }));
  });

  it("preserves an existing English locale when uploading an avatar", async () => {
    const { db, service } = setup({ id: "user-1", nickname: "墨白", avatar_url: null, locale: "en" });

    await service.updateAvatar("user-1", "u@example.com", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    expect(db.upsertUserProfile).toHaveBeenCalledWith(expect.objectContaining({ locale: "en" }));
  });

  it("deletes an uploaded avatar when profile persistence fails", async () => {
    const { db, storage, service } = setup();
    db.upsertUserProfile.mockRejectedValue(new Error("database unavailable"));

    await expect(service.updateAvatar("user-1", "u@example.com", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .rejects.toThrow("database unavailable");
    expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(/^user-1\//));
  });

  it("initializes a legacy profile locale from the request locale", async () => {
    const { db, service } = setup(null);
    db.getUserProfile.mockResolvedValue({ id: "user-1", nickname: "墨白", avatar_url: null, locale: null });
    db.upsertUserProfile.mockResolvedValue({ id: "user-1", nickname: "墨白", avatar_url: null, locale: "en" });

    await expect(service.getProfile("user-1", "u@example.com", "en"))
      .resolves.toMatchObject({ locale: "en" });
    expect(db.upsertUserProfile).toHaveBeenCalledWith({
      userId: "user-1",
      nickname: "墨白",
      avatarUrl: null,
      locale: "en",
    });
  });

  it("keeps a saved locale when the request locale disagrees", async () => {
    const { db, service } = setup({ id: "user-1", nickname: "墨白", avatar_url: null, locale: "en" });

    await expect(service.getProfile("user-1", "u@example.com", "zh-CN"))
      .resolves.toMatchObject({ locale: "en" });
    expect(db.upsertUserProfile).not.toHaveBeenCalled();
  });

  it("updates locale without requiring a display-name change", async () => {
    const { db, service } = setup();
    db.getUserProfile.mockResolvedValue({ id: "user-1", nickname: "墨白", avatar_url: null, locale: "zh-CN" });
    db.upsertUserProfile.mockResolvedValue({ id: "user-1", nickname: "墨白", avatar_url: null, locale: "en" });

    await expect(service.updateProfile("user-1", "u@example.com", { locale: "en" }))
      .resolves.toMatchObject({ locale: "en" });
  });

  it("rejects unsupported locale values", async () => {
    const { service } = setup();
    await expect(service.updateProfile("user-1", "u@example.com", { locale: "fr" as never }))
      .rejects.toMatchObject({ code: "INVALID_PROFILE_LOCALE", status: 400 });
  });

  it.each([
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])],
    ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/webp", Buffer.from("RIFF1234WEBP")],
  ])("accepts matching avatar bytes for %s", async (mime, bytes) => {
    const { db, storage, service } = setup();
    const result = await service.updateAvatar("user-1", "u@example.com", mime, bytes);
    expect(storage.writeBytes).toHaveBeenCalledWith(expect.stringMatching(/^user-1\//), bytes, mime);
    expect(db.upsertUserProfile).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: expect.stringContaining("avatars") }));
    expect(result.avatarUrl).toContain("avatars");
  });

  it("rejects oversized or spoofed avatars", async () => {
    const { service } = setup();
    await expect(service.updateAvatar("user-1", "u@example.com", "image/png", Buffer.from("not png")))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.updateAvatar("user-1", "u@example.com", "image/png", Buffer.alloc(2 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ status: 400 });
  });
});
