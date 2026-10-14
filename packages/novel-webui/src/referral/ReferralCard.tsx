import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { formatDate } from "../i18n/format";
import { useInterfaceLocale } from "../i18n/LocaleProvider";

export function ReferralCard({ onOpenMembership }: { onOpenMembership?: () => void }) {
  const { t } = useTranslation();
  const { locale } = useInterfaceLocale();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const referral = useQuery({ queryKey: ["referrals", "me"], queryFn: () => api.getReferralDashboard() });
  if (referral.isLoading) return <p>{t("referral.loading")}</p>;
  if (referral.isError || !referral.data) return <p role="alert">{t("referral.error")}</p>;
  const data = referral.data;
  const unavailable = data.unavailableReason
    ? t(`referral.unavailable.${data.unavailableReason}`)
    : !data.canInvite ? t("referral.unavailable.generic") : null;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(data.shareUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return <article className="referral-card">
    {data.campaign ? (
      <header className="referral-campaign-folio">
        <span>{t("referral.campaignKicker")}</span>
        <h3>{t("referral.campaignTitle")}</h3>
        <p>{t("referral.promise", { days: data.campaign.rewardDays })}</p>
        <small>{t("referral.campaignDeadline", {
          date: formatDate(data.campaign.bindingEndsAt, locale, { dateStyle: "long" }),
        })}</small>
      </header>
    ) : <p>{t("referral.promise", { days: 10 })}</p>}
    <div className="referral-share-row"><code>{data.code}</code><button className="secondary-button" disabled={!data.canInvite} onClick={() => void copyLink()} type="button">{t("referral.copyLink")}</button></div>
    {copyState !== "idle" ? <p role="status">{t(`referral.${copyState}`)}</p> : null}
    {unavailable ? <p className="profile-empty">{unavailable}</p> : null}
    {data.unavailableReason === "inviter_inactive" && onOpenMembership
      ? <button className="secondary-button referral-membership-action" onClick={onOpenMembership} type="button">{t("referral.viewMembership")}</button>
      : null}
    <dl className="referral-counts">
      <div><dt>{t("referral.successful")}</dt><dd>{data.counts.successful} / {data.campaign?.maxSlots ?? 10}</dd></div>
      <div><dt>{t("referral.pending")}</dt><dd>{data.counts.pending}</dd></div>
      <div><dt>{t("referral.remaining")}</dt><dd>{data.counts.remaining}</dd></div>
    </dl>
    {data.invitations.length ? <ul className="referral-history">{data.invitations.map((item) => <li key={item.id}>
      <span>{item.maskedEmail}</span><strong>{t(`referral.status.${item.status}`)}</strong>
      <small>{t("referral.deadline", { date: formatDate(item.purchaseDeadline, locale, { dateStyle: "medium" }) })}</small>
    </li>)}</ul> : <p className="profile-empty">{t("referral.empty")}</p>}
    {data.rewards.slice(0, 3).map((reward) => <p className="referral-reward" key={`${reward.role}-${reward.grantedAt}`}>
      {t("referral.rewardReceived", { days: reward.days })}
    </p>)}
  </article>;
}
