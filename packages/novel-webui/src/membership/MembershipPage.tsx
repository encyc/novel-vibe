import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Crown, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { formatDate, formatNumber } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import type { MembershipFeatureCategory, MembershipStatus } from "../types";
import { formatCredit } from "../profile/profile-utils";

const CATEGORY_ORDER: readonly MembershipFeatureCategory[] = ["workspace", "creation", "models", "community"];

function formatExpiry(iso: string | null, locale: "zh-CN" | "en"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDate(d, locale, { dateStyle: "medium" });
}

function benefitCopy(t: TFunction, key: string, field: "name" | "free" | "member"): string {
  return t(`membership.benefits.${key}.${field}`, { defaultValue: "" });
}

/** Membership content rendered inside the profile shell at /profile/membership. */
export function MembershipPage() {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage);
  const status = useQuery({ queryKey: ["membership", "status"], queryFn: () => api.getMembershipStatus() });
  const plans = useQuery({ queryKey: ["membership", "plans"], queryFn: () => api.getMembershipPlans() });
  const catalog = useQuery({ queryKey: ["membership", "entitlements"], queryFn: () => api.getMembershipEntitlements() });
  const purchase = useMutation({
    mutationFn: (planId: string) => api.createMembershipPurchase(planId),
    onSuccess: ({ payUrl }) => window.location.assign(payUrl),
  });

  if (status.isLoading || plans.isLoading) {
    return (
      <div className="membership-page" data-embedded="true">
        <p className="membership-loading">{t("membership.loading")}</p>
      </div>
    );
  }
  if (status.isError || plans.isError) {
    return (
      <div className="membership-page" data-embedded="true">
        <p className="membership-loading" role="alert">{t("membership.error")}</p>
      </div>
    );
  }

  const plan = plans.data?.find((item) => item.slug === "monthly") ?? plans.data?.[0];
  const active = status.data?.active === true;
  const entitlements = [...(catalog.data?.catalog ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const planFeatures = new Set(plan?.features ?? []);
  const grouped = CATEGORY_ORDER
    .map((category) => ({
      category,
      items: entitlements.filter((entry) => entry.category === category),
    }))
    .filter((group) => group.items.length > 0);
  const statusData: MembershipStatus | undefined = status.data ?? undefined;

  return (
    <div className="membership-page" data-embedded="true">
      <section className="membership-hero">
        <div className="membership-hero-copy">
          <h1>{t("membership.title")}</h1>
          <p>{t("membership.description")}</p>
          {active && statusData?.expiresAt ? (
            <p className="membership-status-line">
              <span className="membership-status-active">{t("membership.statusActive")}</span>
              {t("membership.statusExpires", { date: formatExpiry(statusData.expiresAt, locale) })}
            </p>
          ) : (
            <p className="membership-status-line">{t("membership.statusInactive")}</p>
          )}
        </div>
        {plan ? (
          <aside aria-label={plan.name} className="membership-plan-card">
            <div className="membership-plan-head">
              <strong>{plan.name}</strong>
              <span className="membership-plan-price">¥{formatNumber(plan.priceCents / 100, locale, { minimumFractionDigits: 2 })}<small> / {formatNumber(plan.durationDays, locale)} {t("membership.days")}</small></span>
            </div>
            {plan.bonusCredits > 0 ? (
              <p className="membership-plan-bonus">{t("membership.bonus", { credits: formatCredit(plan.bonusCredits, locale) })}</p>
            ) : null}
            <button
              className="primary-button"
              disabled={purchase.isPending}
              onClick={() => purchase.mutate(plan.id)}
              type="button"
            >
              {purchase.isPending ? <Loader2 className="spin" size={16} /> : null}
              {active ? t("membership.renew") : t("membership.subscribe")}
            </button>
          </aside>
        ) : (
          <p className="membership-plan-empty">{t("membership.planUnavailable")}</p>
        )}
      </section>

      <section aria-label={t("membership.tableTitle")} className="membership-benefits">
        <div className="membership-benefits-head">
          <span />
          <span>{t("membership.tableHeader.free")}</span>
          <span>{t("membership.tableHeader.member")}</span>
        </div>
        {grouped.map((group) => (
          <div className="membership-benefit-group" key={group.category}>
            <h2>{t(`membership.categories.${group.category}`, { defaultValue: group.category })}</h2>
            {group.items.map((entry) => (
              <div className="membership-benefit-row" key={entry.key}>
                <span className="membership-benefit-name">
                  {benefitCopy(t, entry.key, "name") || entry.key}
                  {planFeatures.has(entry.key) ? <Check aria-hidden="true" size={13} /> : null}
                </span>
                <span className="membership-benefit-free">{benefitCopy(t, entry.key, "free") || "—"}</span>
                <span className="membership-benefit-member">{benefitCopy(t, entry.key, "member") || "—"}</span>
              </div>
            ))}
          </div>
        ))}
        {grouped.length === 0 ? <p className="membership-plan-empty">{t("membership.benefitsUnavailable")}</p> : null}
      </section>

      <footer className="membership-footer">
        <span>{t("membership.footer.manage")}</span>
        <Link to="/profile/settings">{t("settings.byok.title")} →</Link>
      </footer>
    </div>
  );
}
