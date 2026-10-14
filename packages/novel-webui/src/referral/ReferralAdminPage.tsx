import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../api/client";

function localInputValue(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function ReferralAdminPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const metrics = useQuery({ queryKey: ["referrals", "admin", "metrics"], queryFn: () => api.getReferralAdminMetrics() });
  const [deadline, setDeadline] = useState("");
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const bindings = useQuery({ queryKey: ["referrals", "admin", "bindings", search], queryFn: () => api.listReferralAdminBindings({ search: search || undefined }) });
  const update = useMutation({
    mutationFn: (input: { bindingEndsAt: string; reason: string }) => api.updateReferralCampaign(input),
    onSuccess: () => client.invalidateQueries({ queryKey: ["referrals"] }),
  });
  const review = useMutation({
    mutationFn: (input: { id: string; decision: "approve" | "reject" }) => api.reviewReferralBinding(input.id, input.decision, t(`referral.admin.${input.decision}Reason`)),
    onSuccess: () => client.invalidateQueries({ queryKey: ["referrals"] }),
  });

  function save(event: FormEvent) {
    event.preventDefault();
    if (!deadline || !reason.trim()) return;
    update.mutate({ bindingEndsAt: new Date(deadline).toISOString(), reason: reason.trim() });
  }

  const totals = metrics.data?.totals;
  return <main className="profile-page referral-admin-page">
    <header className="profile-topbar"><Link to="/projects">← {t("profile.back")}</Link></header>
    <div className="profile-content"><div className="profile-title"><span>REFERRAL OPERATIONS</span><h1>{t("referral.admin.title")}</h1><p>{t("referral.admin.subtitle")}</p></div>
      {metrics.isError ? <p role="alert">{t("referral.admin.forbidden")}</p> : null}
      {metrics.data ? <>
        <section className="profile-section"><h2>{t("referral.admin.deadline")}</h2>
          <p>{new Date(metrics.data.campaign.binding_ends_at).toLocaleString()}</p>
          <form className="referral-admin-form" onSubmit={save}>
            <label>{t("referral.admin.newDeadline")}<input onChange={(event) => setDeadline(event.target.value)} type="datetime-local" value={deadline || localInputValue(metrics.data.campaign.binding_ends_at)} /></label>
            <label>{t("referral.admin.reason")}<input onChange={(event) => setReason(event.target.value)} required value={reason} /></label>
            <button className="primary-button" disabled={update.isPending || !reason.trim()} type="submit">{t("common.save")}</button>
            <button className="secondary-button" onClick={() => {
              if (window.confirm(t("referral.admin.closeConfirm"))) update.mutate({ bindingEndsAt: new Date().toISOString(), reason: t("referral.admin.closeReason") });
            }} type="button">{t("referral.admin.close")}</button>
          </form>
        </section>
        <section className="profile-section"><h2>{t("referral.admin.metrics")}</h2><dl className="referral-counts">
          {totals ? Object.entries(totals).map(([key, value]) => <div key={key}><dt>{t(`referral.admin.metric.${key}`)}</dt><dd>{value}</dd></div>) : null}
        </dl></section>
        <section className="profile-section"><h2>{t("referral.admin.bindings")}</h2>
          <input aria-label={t("referral.admin.search")} onChange={(event) => setSearch(event.target.value)} placeholder={t("referral.admin.search")} type="search" value={search} />
          <ul className="referral-history">{bindings.data?.map((binding) => <li key={binding.id}><span>{binding.invitee_email}</span><strong>{binding.status}</strong>
            {binding.status === "risk_pending" ? <div><button onClick={() => window.confirm(t("referral.admin.approveConfirm")) && review.mutate({ id: binding.id, decision: "approve" })} type="button">{t("referral.admin.approve")}</button><button onClick={() => window.confirm(t("referral.admin.rejectConfirm")) && review.mutate({ id: binding.id, decision: "reject" })} type="button">{t("referral.admin.reject")}</button></div> : null}
          </li>)}</ul>
        </section>
      </> : null}
    </div>
  </main>;
}
