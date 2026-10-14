import type { CreditActivityDay } from "../types";
import { formatDate, formatNumber } from "../i18n/format";
import type { InterfaceLocale } from "../i18n/locale";

export function daysInYear(year: number): string[] {
  const result: string[] = [];
  const date = new Date(Date.UTC(year, 0, 1));
  while (date.getUTCFullYear() === year) {
    result.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return result;
}

export function buildCreditLevels(days: CreditActivityDay[]): Map<string, 0 | 1 | 2 | 3 | 4> {
  const positive = days.map((day) => day.totalTokens).filter((value) => value > 0).sort((a, b) => a - b);
  const thresholds = [0.25, 0.5, 0.75].map((point) => positive[Math.max(0, Math.ceil(positive.length * point) - 1)] ?? 0);
  return new Map(days.map((day) => {
    const value = day.totalTokens;
    const level = value <= 0 ? 0 : value <= thresholds[0] ? 1 : value <= thresholds[1] ? 2 : value <= thresholds[2] ? 3 : 4;
    return [day.date, level] as const;
  }));
}

export function formatCredit(value: number, locale: InterfaceLocale): string {
  return formatNumber(value, locale, { maximumFractionDigits: 2 });
}

export function formatDateLabel(date: string, locale: InterfaceLocale): string {
  return formatDate(`${date}T00:00:00Z`, locale, { day: "numeric", month: "long", timeZone: "UTC", year: "numeric" });
}

export interface MonthMark { label: string; col: number }

/**
 * Compute which grid columns month labels should sit at, and which weekday rows
 * to decorate, for a GitHub-style contributions heatmap.
 *
 * The grid is 7 rows (Mon=1 .. Sun=7) with auto columns (one per week).
 * startOffset = (Jan-1 weekday (Mon=0..Sun=6) + 6) % 7 → used as the
 * grid-row-start of the first cell; the column of day N is floor((N + offset) / 7).
 */
export function buildHeatmapAxis(
  year: number,
  startOffset: number,
  locale: InterfaceLocale,
): { months: MonthMark[]; weekdayRows: string[] } {
  const months: MonthMark[] = [];
  for (let m = 0; m < 12; m++) {
    const firstOfMonth = new Date(Date.UTC(year, m, 1));
    // day index 0 = Jan 1
    const dayIndex = Math.floor((firstOfMonth.getTime() - Date.UTC(year, 0, 0)) / 86_400_000) - 1;
    months.push({ label: formatDate(firstOfMonth, locale, { month: "short", timeZone: "UTC" }), col: Math.floor((dayIndex + startOffset) / 7) });
  }
  // Deduplicate consecutive identical columns (two months can land on same col in tight weeks)
  const deduped: MonthMark[] = [];
  for (const m of months) {
    const prev = deduped.at(-1);
    if (!prev || m.col > prev.col + 1) deduped.push(m);
  }

  return {
    months: deduped,
    weekdayRows: [0, 1, 2, 3, 4, 5, 6].map((offset) => offset % 2 === 0
      ? formatDate(new Date(Date.UTC(2026, 0, 5 + offset)), locale, { weekday: "narrow", timeZone: "UTC" })
      : ""),
  };
}
