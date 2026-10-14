import { beforeEach, describe, expect, it } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("findActiveUserLlmKey", () => {
  it("queries by owner and provider with an active predicate", async () => {
    ctx.mockOk();
    await ctx.db.findActiveUserLlmKey("user-1", "deepseek");
    const [url] = ctx.fetchMock.mock.calls[0];
    expect(url).toContain("/user_llm_keys");
    expect(url).toContain("user_id=eq.user-1");
    expect(url).toContain("provider=eq.deepseek");
    expect(url).toContain("revoked_at=is.null");
  });

  it("returns null when no row matches", async () => {
    ctx.fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    expect(await ctx.db.findActiveUserLlmKey("user-1", "deepseek")).toBeNull();
  });
});

describe("upsertUserLlmKey", () => {
  it("updates the existing active row in place", async () => {
    ctx.fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "row-1" }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "row-1" }]), { status: 200 }));
    await ctx.db.upsertUserLlmKey({
      userId: "user-1",
      provider: "deepseek",
      encryptedKey: "v1:aa:bb:cc",
      keyLast4: "ab12",
    });
    const [, updateOpts] = ctx.fetchMock.mock.calls[1];
    expect(updateOpts.method).toBe("PATCH");
    expect(updateOpts.body).toContain('"encrypted_key":"v1:aa:bb:cc"');
    expect(updateOpts.body).toContain('"key_last4":"ab12"');
  });

  it("inserts when no active row exists", async () => {
    ctx.fetchMock
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "row-2" }]), { status: 201 }));
    await ctx.db.upsertUserLlmKey({
      userId: "user-1",
      provider: "openai",
      encryptedKey: "v1:dd:ee:ff",
      keyLast4: "xy99",
    });
    const [, insertOpts] = ctx.fetchMock.mock.calls[1];
    expect(insertOpts.method).toBe("POST");
    expect(insertOpts.body).toContain('"provider":"openai"');
  });
});

describe("revokeUserLlmKey", () => {
  it("soft-revokes with an explicit owner predicate", async () => {
    ctx.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ id: "row-1" }]), { status: 200 }));
    const revoked = await ctx.db.revokeUserLlmKey("user-1", "deepseek");
    expect(revoked).toBe(true);
    const [url, opts] = ctx.fetchMock.mock.calls[0];
    expect(url).toContain("user_id=eq.user-1");
    expect(url).toContain("revoked_at=is.null");
    expect(opts.method).toBe("PATCH");
    expect(opts.body).toContain("revoked_at");
  });
});
