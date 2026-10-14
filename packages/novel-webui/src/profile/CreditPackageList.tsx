import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { formatNumber } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import { formatCredit } from "./profile-utils";

export function CreditPackageList() {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage);
  const packages = useQuery({ queryKey: ["credits", "packages"], queryFn: () => api.listCreditPackages() });
  const purchase = useMutation({ mutationFn: (packageId: string) => api.createCreditPurchase(packageId), onSuccess: ({ payUrl }) => window.location.assign(payUrl) });
  if (packages.isLoading) return <p>{t("profile.credits.packages.loading")}</p>;
  if (packages.isError) return <p role="alert">{t("profile.credits.packages.error")}</p>;
  if (!packages.data?.length) return <p className="profile-empty">{t("profile.credits.packages.empty")}</p>;
  return <div className="credit-package-grid">{packages.data.map((item) => <article className="credit-package" key={item.id}><div><strong>{item.name}</strong><span>¥{formatNumber(item.priceCents / 100, locale, { minimumFractionDigits: 2 })}</span></div><p>{t("profile.credits.packages.amount", { credits: formatCredit(item.credits, locale) })}{item.bonusCredits > 0 ? t("profile.credits.packages.bonus", { credits: formatCredit(item.bonusCredits, locale) }) : ""}</p><button className="secondary-button" disabled={purchase.isPending} onClick={() => purchase.mutate(item.id)} type="button">{t("profile.credits.packages.topup")}</button></article>)}</div>;
}
