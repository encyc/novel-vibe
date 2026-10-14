const PUBLIC_ORIGIN = "https://lingqiai.art";
const APP_ORIGIN = "https://app.lingqiai.art";

function currentOrigin(): string {
  return typeof window === "undefined" ? APP_ORIGIN : window.location.origin;
}

function localOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function communityUrl(suffix = "", origin = currentOrigin()): string {
  const normalized = suffix && !suffix.startsWith("/") ? `/${suffix}` : suffix;
  return `${localOrigin(origin) ?? PUBLIC_ORIGIN}/community${normalized}`;
}

export function appUrl(path = "", origin = currentOrigin()): string {
  const normalized = path && !path.startsWith("/") ? `/${path}` : path;
  return `${localOrigin(origin) ?? APP_ORIGIN}${normalized}`;
}
