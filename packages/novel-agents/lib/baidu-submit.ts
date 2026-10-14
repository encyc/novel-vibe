export interface BaiduSubmitEnv {
  BAIDU_PUSH_SITE?: string;
  BAIDU_PUSH_TOKEN?: string;
  BAIDU_PUSH_ENDPOINT?: string;
}

export type BaiduSubmitResult =
  | { status: "skipped"; reason: "missing_configuration" | "invalid_site" | "empty_urls" }
  | { status: "submitted"; httpStatus: number; urlCount: number; accepted?: number; remain?: number }
  | { status: "failed"; httpStatus?: number; urlCount: number };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function submitBaiduUrls(
  urls: string[],
  env: BaiduSubmitEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<BaiduSubmitResult> {
  const site = env.BAIDU_PUSH_SITE?.trim();
  const token = env.BAIDU_PUSH_TOKEN?.trim();
  if (!site || !token) return { status: "skipped", reason: "missing_configuration" };

  let siteUrl: URL;
  try {
    siteUrl = new URL(site);
  } catch {
    return { status: "skipped", reason: "invalid_site" };
  }

  const canonicalUrls = Array.from(new Set(urls.flatMap((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && parsed.host === siteUrl.host ? [parsed.href] : [];
    } catch {
      return [];
    }
  })));
  if (canonicalUrls.length === 0) return { status: "skipped", reason: "empty_urls" };

  const endpoint = new URL(env.BAIDU_PUSH_ENDPOINT?.trim() || "http://data.zz.baidu.com/urls");
  endpoint.searchParams.set("site", site);
  endpoint.searchParams.set("token", token);

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: canonicalUrls.join("\n"),
    });
    if (!response.ok) {
      return { status: "failed", httpStatus: response.status, urlCount: canonicalUrls.length };
    }
    let payload: { success?: unknown; remain?: unknown } = {};
    try {
      payload = await response.json() as { success?: unknown; remain?: unknown };
    } catch {
      // A 2xx status is sufficient; response counters are optional diagnostics.
    }
    return {
      status: "submitted",
      httpStatus: response.status,
      urlCount: canonicalUrls.length,
      ...(typeof payload.success === "number" ? { accepted: payload.success } : {}),
      ...(typeof payload.remain === "number" ? { remain: payload.remain } : {}),
    };
  } catch {
    return { status: "failed", urlCount: canonicalUrls.length };
  }
}
