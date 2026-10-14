export const SUPPORTED_LANGUAGES = ["zh-CN", "en"] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string"
    && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export function normalizeSupportedLanguage(
  value: unknown,
  fallback: SupportedLanguage = "zh-CN",
): SupportedLanguage {
  if (isSupportedLanguage(value)) return value;
  if (typeof value === "string" && value.toLowerCase().startsWith("en")) return "en";
  if (typeof value === "string" && value.toLowerCase().startsWith("zh")) return "zh-CN";
  return fallback;
}
