export type InterfaceLocale = "zh-CN" | "en";

const INTERFACE_LOCALE_STORAGE_KEY = "novel-vibe:interface-locale";
export const INTERFACE_LOCALE_COOKIE_NAME = "novel-vibe-locale";

export function normalizeInterfaceLocale(value: unknown): InterfaceLocale {
  if (typeof value === "string" && value.toLowerCase().startsWith("en")) return "en";
  return "zh-CN";
}

export function detectBrowserLocale(): InterfaceLocale {
  return normalizeInterfaceLocale(globalThis.navigator?.language);
}

export function readStoredLocale(storage = globalThis.localStorage): InterfaceLocale | null {
  const value = storage?.getItem(INTERFACE_LOCALE_STORAGE_KEY);
  return value === "zh-CN" || value === "en" ? value : null;
}

export function storeLocale(locale: InterfaceLocale, storage = globalThis.localStorage): void {
  storage?.setItem(INTERFACE_LOCALE_STORAGE_KEY, locale);
  if (globalThis.document) {
    const secure = globalThis.location?.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${INTERFACE_LOCALE_COOKIE_NAME}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }
}
