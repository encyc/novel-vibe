import type { CreditActivityDay } from "../types";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import { buildCreditLevels, buildHeatmapAxis, daysInYear, formatCredit, formatDateLabel } from "./profile-utils";

export function CreditActivityHeatmap({ days, year }: { days: CreditActivityDay[]; year: number }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage);
  const valueMap = new Map(days.map((day) => [day.date, day]));
  const levels = buildCreditLevels(days);
  const dates = daysInYear(year);
  const startOffset = (new Date(`${year}-01-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const { months, weekdayRows } = buildHeatmapAxis(year, startOffset, locale);

  return (
    <div className="credit-heatmap-wrap">
      <div className="credit-heatmap-area">
        {/* month labels above the grid */}
        <div className="credit-heatmap-months" style={{ gridColumn: `2 / -1` } as React.CSSProperties}>
          {months.map((m) => (
            <span key={m.label} style={{ gridColumn: `${m.col + 1} / span 1` }}>{m.label}</span>
          ))}
        </div>

        {/* weekday labels on the left */}
        <div className="credit-heatmap-weekdays">
          {weekdayRows.map((label, i) => (
            <span key={i}>{label}</span>
          ))}
        </div>

        {/* the grid of cells */}
        <div aria-label={t("profile.credits.activity.aria", { year })} className="credit-heatmap" role="grid" style={{ "--heatmap-offset": startOffset } as React.CSSProperties}>
          {dates.map((date, index) => {
            const day = valueMap.get(date);
            const label = day
              ? t("profile.credits.activity.dayLabel", {
                credits: formatCredit(day.creditsConsumed, locale),
                date: formatDateLabel(date, locale),
                tokens: formatNumber(day.totalTokens, locale),
              })
              : formatDateLabel(date, locale);
            return <button aria-label={label} className="credit-heatmap-cell" data-level={levels.get(date) ?? 0} key={date} role="gridcell" style={index === 0 ? { gridRowStart: startOffset + 1 } : undefined} title={label} type="button" />;
          })}
        </div>
      </div>
      <div className="credit-heatmap-legend" aria-label={t("profile.credits.activity.legendAria")}><span>{t("profile.credits.activity.less")}</span>{[0, 1, 2, 3, 4].map((level) => <i data-level={level} key={level} />)}<span>{t("profile.credits.activity.more")}</span></div>
    </div>
  );
}
