import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, LogOut } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { InterfaceLanguageSelector } from "../i18n/InterfaceLanguageSelector";
import { useLocalMode } from "../local-mode";
import { MembershipPage } from "../membership/MembershipPage";
import { ReferralCard } from "../referral/ReferralCard";
import { SettingsPage } from "../settings/SettingsPage";
import type { ReferralDashboard, User } from "../types";
import { ApiTokenCard } from "./ApiTokenCard";
import { CreditActivityHeatmap } from "./CreditActivityHeatmap";
import { CreditLedger } from "./CreditLedger";
import { CreditPackageList } from "./CreditPackageList";
import { CreditSummary } from "./CreditSummary";
import { PaymentStatusNotice, type PaymentConfirmation } from "./PaymentStatusNotice";
import { ProfileIdentityCard } from "./ProfileIdentityCard";
import {
  CLOUD_ONLY_PROFILE_SECTIONS,
  ProfileNavigation,
  type ProfileSectionId,
  type ReferralCampaignNavigation,
} from "./ProfileNavigation";

const SECTION_META: Record<ProfileSectionId, { marker: string; titleKey: string; introKey?: string }> = {
  identity: { marker: "IDENTITY", titleKey: "profile.navigation.sections.identity" },
  preferences: { marker: "PREFERENCES", titleKey: "profile.navigation.sections.preferences" },
  balance: { marker: "BALANCE", titleKey: "profile.navigation.sections.balance" },
  activity: { marker: "ACTIVITY", titleKey: "profile.navigation.sections.activity" },
  records: { marker: "LEDGER", titleKey: "profile.navigation.sections.records" },
  topup: { marker: "TOP UP", titleKey: "profile.navigation.sections.topup", introKey: "profile.topUpIntro" },
  membership: { marker: "MEMBERSHIP", titleKey: "profile.navigation.sections.membership" },
  settings: { marker: "BYOK", titleKey: "settings.byok.title" },
  referral: { marker: "REFERRAL", titleKey: "profile.navigation.sections.referral" },
  api: { marker: "MCP ACCESS", titleKey: "profile.navigation.sections.api", introKey: "profile.apiTokenIntro" },
};

function isProfileSectionId(value: string | undefined): value is ProfileSectionId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SECTION_META, value);
}

/** Legacy `?section=` / payment-return queries before the URL-driven sections. */
function initialSection(): ProfileSectionId {
  const params = new URLSearchParams(window.location.search);
  const orderNo = params.get("out_trade_no") ?? params.get("order_no");
  if (orderNo) return orderNo.startsWith("MC-") ? "membership" : "topup";
  const section = params.get("section");
  return isProfileSectionId(section ?? undefined) ? section as ProfileSectionId : "identity";
}

function referralCampaignNavigation(data: ReferralDashboard | undefined): ReferralCampaignNavigation | undefined {
  if (!data?.campaign) return undefined;
  if (data.canInvite) return { kind: "eligible", rewardDays: data.campaign.rewardDays };
  return data.unavailableReason === "inviter_inactive" ? { kind: "membership" } : undefined;
}

function ProfileSectionFrame({ children, intro, marker, title }: {
  children: ReactNode;
  intro?: string;
  marker: string;
  title: string;
}) {
  return (
    <div className="profile-section">
      <div className="profile-section-heading">
        <h2 id="profile-active-section-title">{title}</h2>
        <span>{marker}</span>
      </div>
      {intro ? <p className="profile-section-intro">{intro}</p> : null}
      {children}
    </div>
  );
}

export function ProfilePage({ onSignedOut, user }: { user: User; onSignedOut: () => void }) {
  const { t } = useTranslation();
  const localMode = useLocalMode();
  const navigate = useNavigate();
  const { sectionId } = useParams();
  const year = new Date().getFullYear();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const client = useQueryClient();
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api.getProfile() });
  const summary = useQuery({ queryKey: ["credits", "summary"], queryFn: () => api.getCreditSummary(), enabled: !localMode });
  const activity = useQuery({ queryKey: ["credits", "activity", year, timezone], queryFn: () => api.getCreditActivity(year, timezone), enabled: !localMode });
  const referral = useQuery({ queryKey: ["referrals", "me"], queryFn: () => api.getReferralDashboard(), retry: false, enabled: !localMode });
  const fallbackSection = useMemo(initialSection, []);
  // URL is the single source of truth for the active section; localSection is
  // the fallback for renders outside a matching <Route> (tests), and the
  // legacy ?section / payment-return queries only seed the initial render.
  const routeSection: ProfileSectionId | null = isProfileSectionId(sectionId) ? sectionId : null;
  const [localSection, setLocalSection] = useState<ProfileSectionId | null>(null);
  // A stale link or bookmark can still name a hosted-only section in local mode;
  // fall back to the identity card instead of rendering an unavailable page.
  const requestedSection: ProfileSectionId = routeSection ?? localSection ?? fallbackSection;
  const activeSection: ProfileSectionId = localMode && CLOUD_ONLY_PROFILE_SECTIONS.has(requestedSection)
    ? "identity"
    : requestedSection;
  const openSection = (section: ProfileSectionId) => {
    setLocalSection(section);
    navigate(`/profile/${section}`);
  };
  const [payment, setPayment] = useState<PaymentConfirmation>({ kind: "idle" });

  useEffect(() => {
    const returnParams = new URLSearchParams(window.location.search);
    const orderNo = returnParams.get("out_trade_no") ?? returnParams.get("order_no");
    if (!orderNo) return;
    setLocalSection(orderNo.startsWith("MC-") ? "membership" : "topup");
    navigate(orderNo.startsWith("MC-") ? "/profile/membership" : "/profile/topup", { replace: true });
    setPayment({ kind: "checking", orderNo });
    const started = Date.now(); let timer = 0; let stopped = false;
    const poll = async () => {
      try {
        const isMembership = orderNo.startsWith("MC-");
        const result = isMembership ? await api.getMembershipPurchase(orderNo) : await api.getCreditPurchase(orderNo);
        if (stopped) return;
        if (result.status === "completed") {
          setPayment({ kind: "completed", orderNo });
          await client.invalidateQueries({ queryKey: ["credits"] });
          if (isMembership) {
            await Promise.all([
              client.invalidateQueries({ queryKey: ["membership"] }),
              client.invalidateQueries({ queryKey: ["referrals"] }),
            ]);
          }
          return;
        }
        if (result.status === "failed") {
          setPayment({ kind: "failed", orderNo, message: t("profile.paymentIncomplete") });
          return;
        }
      } catch { /* transient confirmation errors keep polling */ }
      const elapsed = Date.now() - started;
      if (elapsed >= 120_000) { setPayment({ kind: "pending-timeout", orderNo }); return; }
      timer = window.setTimeout(poll, elapsed < 30_000 ? 2_000 : 5_000);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [client, t, navigate]);

  async function signOut() {
    await api.logout();
    onSignedOut();
  }

  function renderActiveSection(): ReactNode {
    switch (activeSection) {
      case "identity":
        return profile.data
          ? <ProfileIdentityCard profile={profile.data} />
          : profile.isError
            ? <p role="alert">{t("profile.identityFailed")}</p>
            : <p>{t("profile.identityLoading")}</p>;
      case "preferences":
        return <InterfaceLanguageSelector authenticated />;
      case "balance":
        return summary.data ? <CreditSummary summary={summary.data} /> : <p>{t("profile.creditLoading")}</p>;
      case "activity":
        return activity.data ? <CreditActivityHeatmap days={activity.data} year={year} /> : <p>{t("profile.activityLoading")}</p>;
      case "records":
        return <CreditLedger />;
      case "topup":
        return <CreditPackageList />;
      case "membership":
        return <MembershipPage />;
      case "settings":
        return <SettingsPage />;
      case "referral":
        return <ReferralCard onOpenMembership={() => openSection("membership")} />;
      case "api":
        return <ApiTokenCard />;
    }
  }

  const section = SECTION_META[activeSection];
  return (
    <main className="profile-page">
      <header className="profile-topbar">
        <Link to="/projects"><ArrowLeft size={16} />{t("profile.back")}</Link>
        <button aria-label={t("profile.signOut")} className="icon-button" onClick={signOut} type="button"><LogOut size={17} /></button>
      </header>
      <div className="profile-content">
        <div className="profile-title"><h1>{t("profile.title")}</h1><p>{t("profile.subtitle")}</p></div>
        <div className="profile-ledger-layout">
          <ProfileNavigation
            current={activeSection}
            onChange={openSection}
            profile={profile.data}
            referralCampaign={referralCampaignNavigation(referral.data)}
            user={user}
          />
          <section aria-labelledby="profile-active-section-title" className="profile-ledger-main">
            <PaymentStatusNotice state={payment} />
            <ProfileSectionFrame key={activeSection} intro={section.introKey ? t(section.introKey) : undefined} marker={section.marker} title={t(section.titleKey)}>
              {renderActiveSection()}
            </ProfileSectionFrame>
          </section>
        </div>
      </div>
    </main>
  );
}
