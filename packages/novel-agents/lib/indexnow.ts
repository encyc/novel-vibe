export interface IndexNowEnv {
  INDEXNOW_KEY?: string;
  INDEXNOW_ENDPOINT?: string;
  INDEXNOW_HOST?: string;
  INDEXNOW_KEY_LOCATION?: string;
}

export type IndexNowResult =
  | { status: "skipped"; reason: "missing_key" | "invalid_key" | "empty_urls" }
  | { status: "submitted"; httpStatus: number; urlCount: number }
  | { status: "failed"; httpStatus?: number; urlCount: number };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export async function notifyIndexNow(
  urls: string[],
  env: IndexNowEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<IndexNowResult> {
  const key = env.INDEXNOW_KEY?.trim();
  if (!key) return { status: "skipped", reason: "missing_key" };
  if (!INDEXNOW_KEY_PATTERN.test(key)) return { status: "skipped", reason: "invalid_key" };

  const host = env.INDEXNOW_HOST?.trim() || "lingqiai.art";
  const canonicalUrls = Array.from(new Set(urls.flatMap((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && parsed.host === host ? [parsed.href] : [];
    } catch {
      return [];
    }
  })));
  if (canonicalUrls.length === 0) return { status: "skipped", reason: "empty_urls" };

  const endpoint = env.INDEXNOW_ENDPOINT?.trim() || "https://api.indexnow.org/indexnow";
  const keyLocation = env.INDEXNOW_KEY_LOCATION?.trim() || `https://${host}/${key}.txt`;
  const body = JSON.stringify({ host, key, keyLocation, urlList: canonicalUrls });

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
    });
    if (response.status === 200 || response.status === 202) {
      return { status: "submitted", httpStatus: response.status, urlCount: canonicalUrls.length };
    }
    return { status: "failed", httpStatus: response.status, urlCount: canonicalUrls.length };
  } catch {
    return { status: "failed", urlCount: canonicalUrls.length };
  }
}
