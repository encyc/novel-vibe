import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiTokenRepository,
  ApiTokenRow,
  InsertApiTokenInput,
} from "./api-token-repository.js";
import { ApiTokenService } from "./api-token-service.js";

const NOW = new Date("2026-07-07T12:00:00.000Z");

function row(overrides: Partial<ApiTokenRow> = {}): ApiTokenRow {
  return {
    id: "token-id",
    public_id: "abcdefghijklmnop",
    secret_hash: createHash("sha256").update("a".repeat(43)).digest("hex"),
    user_id: "user-id",
    name: "Desktop client",
    scopes: ["projects:read", "agents:run"],
    expires_at: "2026-10-05T12:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

function repository() {
  return {
    insert: vi.fn<(input: InsertApiTokenInput) => Promise<ApiTokenRow>>(),
    listByOwner: vi.fn<ApiTokenRepository["listByOwner"]>(),
    findActiveByPublicId: vi.fn<ApiTokenRepository["findActiveByPublicId"]>(),
    revokeOwned: vi.fn<ApiTokenRepository["revokeOwned"]>(),
    touchLastUsed: vi.fn<ApiTokenRepository["touchLastUsed"]>(),
  };
}

describe("ApiTokenService", () => {
  let repo: ReturnType<typeof repository>;
  let service: ApiTokenService;

  beforeEach(() => {
    repo = repository();
    repo.listByOwner.mockResolvedValue([]);
    service = new ApiTokenService(repo, { now: () => NOW });
  });

  it("returns a base64url-safe lingqi token once and stores only its SHA-256 hash", async () => {
    repo.insert.mockImplementation(async (input) => row({
      public_id: input.publicId,
      secret_hash: input.secretHash,
      user_id: input.ownerId,
      name: input.name,
      scopes: input.scopes,
      expires_at: input.expiresAt,
    }));

    const created = await service.create({
      ownerId: "user-id",
      name: " Desktop client ",
      scopes: ["projects:read"],
      lifetimeDays: 30,
    });

    expect(created.token).toMatch(/^lingqi_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
    const secret = created.token.slice("lingqi_".length + 16 + 1);
    const inserted = repo.insert.mock.calls[0]![0];
    expect(inserted.secretHash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(inserted).not.toHaveProperty("token");
    expect(inserted).not.toHaveProperty("secret");
    expect(created).not.toHaveProperty("secret_hash");
    expect(created.name).toBe("Desktop client");
    await expect(service.list("user-id")).resolves.not.toContainEqual(
      expect.objectContaining({ token: expect.anything() }),
    );
  });

  it.each([
    [30, "2026-08-06T12:00:00.000Z"],
    [90, "2026-10-05T12:00:00.000Z"],
    [365, "2027-07-07T12:00:00.000Z"],
  ] as const)("creates tokens with an exact %i-day lifetime", async (lifetimeDays, expiresAt) => {
    repo.insert.mockImplementation(async (input) => row({ expires_at: input.expiresAt }));
    await service.create({
      ownerId: "user-id",
      name: "client",
      scopes: ["projects:read"],
      lifetimeDays,
    });
    expect(repo.insert.mock.calls[0]![0].expiresAt).toBe(expiresAt);
  });

  it.each([
    [{ ownerId: "user-id", name: "", scopes: ["projects:read"], lifetimeDays: 30 }, "name"],
    [{ ownerId: "user-id", name: "client", scopes: [], lifetimeDays: 30 }, "scope"],
    [{ ownerId: "user-id", name: "client", scopes: ["unknown"], lifetimeDays: 30 }, "scope"],
    [{ ownerId: "user-id", name: "client", scopes: ["tokens:manage"], lifetimeDays: 30 }, "delegable"],
    [{ ownerId: "user-id", name: "client", scopes: ["projects:read"], lifetimeDays: 31 }, "lifetime"],
  ])("rejects invalid creation input %#", async (input, message) => {
    await expect(service.create(input as never)).rejects.toThrow(message);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("delegates list and owner-scoped revocation to the repository", async () => {
    repo.listByOwner.mockResolvedValue([]);
    repo.revokeOwned.mockResolvedValue(true);
    await expect(service.list("user-id")).resolves.toEqual([]);
    await expect(service.revoke("token-id", "user-id")).resolves.toBe(true);
    expect(repo.revokeOwned).toHaveBeenCalledWith("token-id", "user-id", NOW.toISOString());
  });

  it.each([
    "",
    "bearer abc",
    "lingqi_too-short_secret",
    `lingqi_${"a".repeat(16)}_${"!".repeat(43)}`,
  ])("rejects malformed token %j without throwing", async (token) => {
    await expect(service.authenticate(token)).resolves.toBeNull();
    expect(repo.findActiveByPublicId).not.toHaveBeenCalled();
  });

  it("rejects unknown, revoked, and expired tokens", async () => {
    repo.findActiveByPublicId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ revoked_at: NOW.toISOString() }))
      .mockResolvedValueOnce(row({ expires_at: NOW.toISOString() }));
    const token = `lingqi_${"a".repeat(16)}_${"a".repeat(43)}`;
    await expect(service.authenticate(token)).resolves.toBeNull();
    await expect(service.authenticate(token)).resolves.toBeNull();
    await expect(service.authenticate(token)).resolves.toBeNull();
    expect(repo.touchLastUsed).not.toHaveBeenCalled();
  });

  it("rejects an incorrect same-length secret and reconstructs scopes for a valid secret", async () => {
    const publicId = "abcdefghijklmnop";
    const secret = "a".repeat(43);
    repo.findActiveByPublicId.mockResolvedValue(row());

    await expect(service.authenticate(`lingqi_${publicId}_${"b".repeat(43)}`)).resolves.toBeNull();
    await expect(service.authenticate(`lingqi_${publicId}_${secret}`)).resolves.toEqual({
      userId: "user-id",
      authType: "api_token",
      scopes: new Set(["projects:read", "agents:run"]),
      tokenId: "token-id",
    });
  });

  it("touches last-used only when it is at least one hour stale", async () => {
    const token = `lingqi_abcdefghijklmnop_${"a".repeat(43)}`;
    repo.findActiveByPublicId
      .mockResolvedValueOnce(row({ last_used_at: "2026-07-07T11:00:00.000Z" }))
      .mockResolvedValueOnce(row({ last_used_at: "2026-07-07T11:00:00.001Z" }));
    repo.touchLastUsed.mockResolvedValue(true);

    await expect(service.authenticate(token)).resolves.not.toBeNull();
    await expect(service.authenticate(token)).resolves.not.toBeNull();

    expect(repo.touchLastUsed).toHaveBeenCalledTimes(1);
    expect(repo.touchLastUsed).toHaveBeenCalledWith(
      "token-id",
      NOW.toISOString(),
      "2026-07-07T11:00:00.000Z",
    );
  });

  it("authenticates a valid token when the best-effort last-used touch fails", async () => {
    const token = `lingqi_abcdefghijklmnop_${"a".repeat(43)}`;
    const onTouchError = vi.fn();
    service = new ApiTokenService(repo, { now: () => NOW, onTouchError });
    repo.findActiveByPublicId.mockResolvedValue(row());
    const touchError = new Error("database unavailable");
    repo.touchLastUsed.mockRejectedValue(touchError);

    await expect(service.authenticate(token)).resolves.toEqual({
      userId: "user-id",
      authType: "api_token",
      scopes: new Set(["projects:read", "agents:run"]),
      tokenId: "token-id",
    });
    expect(onTouchError).toHaveBeenCalledWith(touchError);
  });

  it("fails closed for a malformed stored secret hash", async () => {
    const token = `lingqi_abcdefghijklmnop_${"a".repeat(43)}`;
    repo.findActiveByPublicId.mockResolvedValue(row({ secret_hash: "not-a-sha256-hash" }));

    await expect(service.authenticate(token)).resolves.toBeNull();
    expect(repo.touchLastUsed).not.toHaveBeenCalled();
  });

  it.each([
    [["unknown"]],
    [["tokens:manage"]],
    [null],
  ])("fails closed for corrupt or nondelegable persisted scopes: %j", async (scopes) => {
    const token = `lingqi_abcdefghijklmnop_${"a".repeat(43)}`;
    repo.findActiveByPublicId.mockResolvedValue(row({ scopes: scopes as never }));

    await expect(service.authenticate(token)).resolves.toBeNull();
    expect(repo.touchLastUsed).not.toHaveBeenCalled();
  });
});
