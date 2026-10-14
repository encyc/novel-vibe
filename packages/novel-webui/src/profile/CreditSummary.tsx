import type { CreditSummary as CreditSummaryData } from "../types";
import { useTranslation } from "react-i18next";
import { normalizeInterfaceLocale } from "../i18n/locale";
import { formatCredit } from "./profile-utils";

export function CreditSummary({ summary }: { summary: CreditSummaryData }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage);
  const stats: Array<[string, number]> = [
    [t("profile.credits.summary.balance"), summary.balance],
    [t("profile.credits.summary.totalGranted"), summary.totalGranted],
    [t("profile.credits.summary.totalConsumed"), summary.totalConsumed],
  ];
  return (
    <>
      <div className="credit-summary-grid">
        {stats.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{formatCredit(value, locale)}</strong>
            <small>Credit</small>
          </div>
        ))}
      </div>
      <p className="credit-level-line">
        {t("profile.credits.summary.level")} <strong>{summary.levelName}</strong> <small>(Lv.{summary.level})</small>
      </p>
    </>
  );
}
