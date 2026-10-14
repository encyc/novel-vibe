import { describe, expect, it, vi } from "vitest";
import { submitBaiduUrls } from "./baidu-submit.js";

describe("submitBaiduUrls", () => {
  it("posts newline-delimited URLs to the verified Baidu site endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: 1, remain: 99 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await submitBaiduUrls(
      [
        "https://lingqiai.art/community/article-1",
        "https://lingqiai.art/community/article-1",
      ],
      { BAIDU_PUSH_SITE: "https://lingqiai.art", BAIDU_PUSH_TOKEN: "secret-token" },
      fetchMock,
    );

    expect(result).toEqual({ status: "submitted", httpStatus: 200, urlCount: 1, accepted: 1, remain: 99 });
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(String(endpoint)).toContain("http://data.zz.baidu.com/urls?");
    expect(String(endpoint)).toContain("site=https%3A%2F%2Flingqiai.art");
    expect(String(endpoint)).toContain("token=secret-token");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "https://lingqiai.art/community/article-1",
    });
  });

  it("skips incomplete configuration and URLs from another host", async () => {
    const fetchMock = vi.fn();
    await expect(submitBaiduUrls([], {}, fetchMock))
      .resolves.toEqual({ status: "skipped", reason: "missing_configuration" });
    await expect(submitBaiduUrls(
      ["https://example.com/a"],
      { BAIDU_PUSH_SITE: "https://lingqiai.art", BAIDU_PUSH_TOKEN: "secret-token" },
      fetchMock,
    )).resolves.toEqual({ status: "skipped", reason: "empty_urls" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports HTTP and network failures without throwing", async () => {
    const env = { BAIDU_PUSH_SITE: "https://lingqiai.art", BAIDU_PUSH_TOKEN: "secret-token" };
    await expect(submitBaiduUrls(
      ["https://lingqiai.art/community/a"],
      env,
      vi.fn(async () => new Response(JSON.stringify({ error: 401 }), { status: 401 })),
    )).resolves.toEqual({ status: "failed", httpStatus: 401, urlCount: 1 });
    await expect(submitBaiduUrls(
      ["https://lingqiai.art/community/a"],
      env,
      vi.fn(async () => { throw new Error("offline"); }),
    )).resolves.toEqual({ status: "failed", urlCount: 1 });
  });
});
