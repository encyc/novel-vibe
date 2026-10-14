import { describe, expect, it, vi } from "vitest";
import { notifyIndexNow } from "./indexnow.js";

describe("notifyIndexNow", () => {
  it("posts canonical community URLs with the configured key", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));

    const result = await notifyIndexNow(
      [
        "https://lingqiai.art/community/article-1",
        "https://lingqiai.art/community/article-1",
      ],
      { INDEXNOW_KEY: "12345678", INDEXNOW_ENDPOINT: "https://api.indexnow.org/indexnow" },
      fetchMock,
    );

    expect(result).toEqual({ status: "submitted", httpStatus: 202, urlCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("https://api.indexnow.org/indexnow");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" } });
    expect(JSON.parse(String(init?.body))).toEqual({
      host: "lingqiai.art",
      key: "12345678",
      keyLocation: "https://lingqiai.art/12345678.txt",
      urlList: ["https://lingqiai.art/community/article-1"],
    });
  });

  it("skips missing configuration and empty URL sets", async () => {
    const fetchMock = vi.fn();

    await expect(notifyIndexNow(["https://lingqiai.art/community/a"], {}, fetchMock))
      .resolves.toEqual({ status: "skipped", reason: "missing_key" });
    await expect(notifyIndexNow([], { INDEXNOW_KEY: "12345678" }, fetchMock))
      .resolves.toEqual({ status: "skipped", reason: "empty_urls" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects URLs outside the configured host without sending them", async () => {
    const fetchMock = vi.fn();

    await expect(notifyIndexNow(
      ["https://example.com/community/a"],
      { INDEXNOW_KEY: "12345678" },
      fetchMock,
    )).resolves.toEqual({ status: "skipped", reason: "empty_urls" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports HTTP and network failures without throwing", async () => {
    await expect(notifyIndexNow(
      ["https://lingqiai.art/community/a"],
      { INDEXNOW_KEY: "12345678" },
      vi.fn(async () => new Response(null, { status: 429 })),
    )).resolves.toEqual({ status: "failed", httpStatus: 429, urlCount: 1 });

    await expect(notifyIndexNow(
      ["https://lingqiai.art/community/a"],
      { INDEXNOW_KEY: "12345678" },
      vi.fn(async () => { throw new Error("offline"); }),
    )).resolves.toEqual({ status: "failed", urlCount: 1 });
  });
});
