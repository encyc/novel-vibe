import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { formatDate } from "../i18n/format";
import { useInterfaceLocale } from "../i18n/LocaleProvider";
import { dismissReferralNotice, shouldShowReferralNotice } from "./referral-notice-storage";

export function ReferralCampaignNotice({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const { locale } = useInterfaceLocale();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const referral = useQuery({
    queryKey: ["referrals", "me"],
    queryFn: () => api.getReferralDashboard(),
  });
  const data = referral.data;
  const campaign = data?.campaign;
  const deadline = campaign?.bindingEndsAt;

  useEffect(() => {
    if (data && shouldShowReferralNotice(userId, data)) setOpen(true);
  }, [data, userId]);

  if (!data || !campaign || !deadline || !data.canInvite) return null;
  const activeDeadline = deadline;
  const shareUrl = data.shareUrl;
  const remaining = data.counts.remaining;
  const rewardDays = campaign.rewardDays;

  function dismiss() {
    dismissReferralNotice(userId, activeDeadline);
    setOpen(false);
  }

  async function copyInvitation() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      dismiss();
    } catch {
      setCopyFailed(true);
    }
  }

  function openDetails() {
    dismiss();
    navigate("/profile?section=referral");
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content referral-notice" data-motion="dialog-settle">
          <Dialog.Title>{t("referral.notice.title")}</Dialog.Title>
          <Dialog.Description>
            {t("referral.notice.description", { days: rewardDays })}
          </Dialog.Description>
          <div className="referral-notice-summary">
            <p>{t("referral.notice.deadline", {
              date: formatDate(activeDeadline, locale, { dateStyle: "medium" }),
            })}</p>
            <p>{t("referral.notice.remaining", { count: remaining })}</p>
          </div>
          {copyFailed
            ? <p className="referral-notice-status" role="status">{t("referral.notice.copyFailed")}</p>
            : null}
          <button className="referral-notice-detail" onClick={openDetails} type="button">
            {t("referral.notice.details")} <span aria-hidden="true">→</span>
          </button>
          <div className="referral-notice-actions">
            <button className="secondary-button" onClick={dismiss} type="button">
              {t("referral.notice.later")}
            </button>
            <button className="primary-button" onClick={() => void copyInvitation()} type="button">
              {t("referral.notice.copy")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
