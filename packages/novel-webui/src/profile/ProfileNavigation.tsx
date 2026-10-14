import {
  Activity,
  BadgePlus,
  CircleUserRound,
  Crown,
  KeyRound,
  KeySquare,
  Languages,
  ReceiptText,
  UsersRound,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocalMode } from "../local-mode";
import type { User, UserProfile } from "../types";

export type ProfileSectionId =
  | "identity"
  | "preferences"
  | "balance"
  | "activity"
  | "records"
  | "topup"
  | "membership"
  | "settings"
  | "referral"
  | "api";

export type ReferralCampaignNavigation =
  | { kind: "eligible"; rewardDays: number }
  | { kind: "membership" };

interface ProfileNavigationProps {
  current: ProfileSectionId;
  onChange: (section: ProfileSectionId) => void;
  profile: UserProfile | undefined;
  referralCampaign?: ReferralCampaignNavigation;
  user: User;
}

interface ProfileSectionDefinition {
  id: ProfileSectionId;
  icon: LucideIcon;
  labelKey: string;
}

interface ProfileSectionGroup {
  id: "account" | "credits" | "benefits" | "developer";
  labelKey: string;
  sections: ProfileSectionDefinition[];
}

const PROFILE_SECTION_GROUPS: ProfileSectionGroup[] = [
  {
    id: "account",
    labelKey: "profile.navigation.groups.account",
    sections: [
      { id: "identity", icon: CircleUserRound, labelKey: "profile.navigation.sections.identity" },
      { id: "preferences", icon: Languages, labelKey: "profile.navigation.sections.preferences" },
    ],
  },
  {
    id: "credits",
    labelKey: "profile.navigation.groups.credits",
    sections: [
      { id: "balance", icon: WalletCards, labelKey: "profile.navigation.sections.balance" },
      { id: "activity", icon: Activity, labelKey: "profile.navigation.sections.activity" },
      { id: "records", icon: ReceiptText, labelKey: "profile.navigation.sections.records" },
      { id: "topup", icon: BadgePlus, labelKey: "profile.navigation.sections.topup" },
    ],
  },
  {
    id: "benefits",
    labelKey: "profile.navigation.groups.benefits",
    sections: [
      { id: "membership", icon: Crown, labelKey: "profile.navigation.sections.membership" },
      { id: "settings", icon: KeySquare, labelKey: "profile.navigation.sections.settings" },
      { id: "referral", icon: UsersRound, labelKey: "profile.navigation.sections.referral" },
    ],
  },
  {
    id: "developer",
    labelKey: "profile.navigation.groups.developer",
    sections: [{ id: "api", icon: KeyRound, labelKey: "profile.navigation.sections.api" }],
  },
];

/**
 * Sections that only mean something on the hosted service (credit balance,
 * top-up, membership, referrals). A local install has no account to top up and
 * nobody to invite, so {@link ProfileNavigation} and the profile page both drop
 * them instead of offering entries that can only fail.
 */
export const CLOUD_ONLY_PROFILE_SECTIONS: ReadonlySet<ProfileSectionId> = new Set([
  "balance",
  "activity",
  "records",
  "topup",
  "membership",
  "referral",
]);

export function ProfileNavigation({ current, onChange, profile, referralCampaign, user }: ProfileNavigationProps) {
  const { t } = useTranslation();
  const localMode = useLocalMode();
  const groups = localMode
    ? PROFILE_SECTION_GROUPS
      .map((group) => ({ ...group, sections: group.sections.filter((section) => !CLOUD_ONLY_PROFILE_SECTIONS.has(section.id)) }))
      .filter((group) => group.sections.length > 0)
    : PROFILE_SECTION_GROUPS;
  const sections = groups.flatMap((group) => group.sections);
  const displayName = profile?.displayName || user.email.split("@")[0] || t("profile.navigation.fallbackName");
  const email = profile?.email || user.email;
  const avatarUrl = profile?.avatarUrl;
  const campaignLabel = referralCampaign?.kind === "eligible"
    ? t("profile.navigation.campaign.eligible", { days: referralCampaign.rewardDays })
    : referralCampaign?.kind === "membership"
      ? t("profile.navigation.campaign.membership")
      : undefined;

  return (
    <aside aria-label={t("profile.authorIdentity")} className="profile-bookplate">
      <div className="profile-nav-identity">
        <div className="profile-nav-avatar">
          {avatarUrl ? <img alt={t("profile.identityCard.avatarAlt")} src={avatarUrl} /> : <span>{displayName.slice(0, 1)}</span>}
        </div>
        <div className="profile-nav-identity-copy">
          <strong>{displayName}</strong>
          <span>{email}</span>
        </div>
      </div>

      <nav aria-label={t("profile.navigation.aria")} className="profile-desktop-navigation">
        {groups.map((group) => (
          <div className="profile-nav-group" key={group.id}>
            <span className="profile-nav-group-title">{t(group.labelKey)}</span>
            {group.sections.map(({ icon: Icon, id, labelKey }) => (
              <button
                aria-current={current === id ? "page" : undefined}
                aria-label={t(labelKey)}
                data-campaign={id === "referral" && campaignLabel ? "true" : undefined}
                key={id}
                onClick={() => onChange(id)}
                type="button"
              >
                <Icon aria-hidden="true" size={15} />
                <span className="profile-nav-item-copy">
                  <span>{t(labelKey)}</span>
                  {id === "referral" && campaignLabel ? <small>{campaignLabel}</small> : null}
                </span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <label className="profile-mobile-navigation">
        <span>{t("profile.navigation.mobileLabel")}</span>
        <select aria-label={t("profile.navigation.mobileLabel")} onChange={(event) => onChange(event.target.value as ProfileSectionId)} value={current}>
          {sections.map((section) => <option key={section.id} value={section.id}>{t(section.labelKey)}</option>)}
        </select>
        {campaignLabel
          ? <small className="profile-mobile-campaign">{t("profile.navigation.campaign.mobile", { campaign: campaignLabel })}</small>
          : null}
      </label>
    </aside>
  );
}
