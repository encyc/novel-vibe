import type { InterfaceLocale } from "./locale";

export function formatDate(
  value: Date | string,
  locale: InterfaceLocale,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(
    typeof value === "string" ? new Date(value) : value,
  );
}

export function formatNumber(
  value: number,
  locale: InterfaceLocale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatCredit(value: number, locale: InterfaceLocale): string {
  return formatNumber(value, locale, { maximumFractionDigits: 2 });
}
