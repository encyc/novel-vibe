import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { DbClient } from "../lib/db.js";
import {
  ApiTokenRepository,
  type ApiTokenRow,
  type ApiTokenSummary,
} from "./api-token-repository.js";

const tokenRow: ApiTokenRow = {
  id: "token-id",
  public_id: "public-id",
  secret_hash: "sha256-secret",
  user_id: "owner-id",
  name: "Claude Desktop",
  scopes: ["projects:read", "agents:run"],
  expires_at: "2027-07-07T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
  created_at: "2026-07-07T00:00:00.000Z",
};

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("ApiTokenRepository PostgREST adapter", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const db = { pgToken: "system-jwt" } as DbClient;
  let repository: ApiTokenRepository;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    repository = new ApiTokenRepository(db, { postgrestUrl: "http://db.test" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("inserts a secret-bearing row through the system DbClient", async () => {
    fetchMock.mockResolvedValue(response([tokenRow], true, 201));

    await expect(repository.insert({
      publicId: tokenRow.public_id,
      secretHash: tokenRow.secret_hash,
      ownerId: tokenRow.user_id,
      name: tokenRow.name,
      scopes: tokenRow.scopes,
      expiresAt: tokenRow.expires_at,
    })).resolves.toEqual(tokenRow);

    expect(fetchMock).toHaveBeenCalledWith("http://db.test/api_tokens", {
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer system-jwt",
        "Accept-Profile": "novel",
        "Content-Profile": "novel",
        Prefer: "return=representation",
      }),
      body: JSON.stringify({
        public_id: "public-id",
        secret_hash: "sha256-secret",
        user_id: "owner-id",
        name: "Claude Desktop",
        scopes: ["projects:read", "agents:run"],
        expires_at: "2027-07-07T00:00:00.000Z",
      }),
    });
  });

  it("lists an owner's tokens with a projection that excludes secret_hash", async () => {
    fetchMock.mockResolvedValue(response([tokenRow]));

    const result = await repository.listByOwner("owner-id");

    expectTypeOf(result).toEqualTypeOf<ApiTokenSummary[]>();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://db.test/api_tokens?user_id=eq.owner-id&select=id%2Cpublic_id%2Cuser_id%2Cname%2Cscopes%2Cexpires_at%2Clast_used_at%2Crevoked_at%2Ccreated_at&order=created_at.desc",
      { headers: expect.objectContaining({ Authorization: "Bearer system-jwt" }) },
    );
    expect(result[0]).not.toHaveProperty("secret_hash");
  });

  it("finds a non-revoked, unexpired token by public id for trusted authentication", async () => {
    fetchMock.mockResolvedValue(response([tokenRow]));

    await expect(repository.findActiveByPublicId(
      "public-id",
      "2026-07-07T01:00:00.000Z",
    )).resolves.toEqual(tokenRow);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://db.test/api_tokens?public_id=eq.public-id&revoked_at=is.null&expires_at=gt.2026-07-07T01%3A00%3A00.000Z&limit=1",
      { headers: expect.objectContaining({ Authorization: "Bearer system-jwt" }) },
    );
  });

  it("revokes only the requested owner's active token", async () => {
    fetchMock.mockResolvedValue(response([{ id: "token-id" }]));

    await expect(repository.revokeOwned(
      "token-id",
      "owner-id",
      "2026-07-07T02:00:00.000Z",
    )).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://db.test/api_tokens?id=eq.token-id&user_id=eq.owner-id&revoked_at=is.null&select=id",
      {
        method: "PATCH",
        headers: expect.objectContaining({
          "Content-Profile": "novel",
          Prefer: "return=representation",
        }),
        body: JSON.stringify({ revoked_at: "2026-07-07T02:00:00.000Z" }),
      },
    );
  });

  it("touches last use only when the current value predates the cutoff", async () => {
    fetchMock.mockResolvedValue(response([{ id: "token-id" }]));

    await expect(repository.touchLastUsed(
      "token-id",
      "2026-07-07T03:00:00.000Z",
      "2026-07-07T02:00:00.000Z",
    )).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://db.test/api_tokens?id=eq.token-id&revoked_at=is.null&expires_at=gt.2026-07-07T03%3A00%3A00.000Z&or=(last_used_at.is.null%2Clast_used_at.lt.2026-07-07T02%3A00%3A00.000Z)&select=id",
      {
        method: "PATCH",
        headers: expect.objectContaining({ Prefer: "return=representation" }),
        body: JSON.stringify({ last_used_at: "2026-07-07T03:00:00.000Z" }),
      },
    );
  });
});
