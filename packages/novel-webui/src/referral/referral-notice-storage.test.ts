import { beforeEach, describe, expect, it } from "vitest";
import type { ReferralDashboard } from "../types";
import {
  dismissReferralNotice,
  referralNoticeStorageKey,
  shouldShowReferralNotice,
} from "./referral-notice-storage";

function dashboard(bindingEndsAt = "2026-09-01T00:00:00.000Z"): ReferralDashboard {
  return {
    code: "ABCD2345",
    shareUrl: "https://app.example/login?invite=ABCD2345",
    canInvite: true,
    campaign: { bindingEndsAt, rewardDays: 10, maxSlots: 10 },
    counts: { successful: 0, pending: 0, remaining: 10 },
    invitations: [],
    inviteeBinding: null,
    rewards: [],
  };
}

beforeEach(() => localStorage.clear());

describe("referral notice storage", () => {
  it("shows once for one user and one deadline", () => {
    const data = dashboard();
    expect(shouldShowReferralNotice("user-1", data)).toBe(true);
    dismissReferralNotice("user-1", data.campaign!.bindingEndsAt);
    expect(localStorage.getItem(referralNoticeStorageKey("user-1"))).toBe(data.campaign!.bindingEndsAt);
    expect(shouldShowReferralNotice("user-1", data)).toBe(false);
  });

  it("shows again after an extension and isolates accounts", () => {
    dismissReferralNotice("user-1", "2026-09-01T00:00:00.000Z");
    expect(shouldShowReferralNotice("user-1", dashboard("2026-10-01T00:00:00.000Z"))).toBe(true);
    expect(shouldShowReferralNotice("user-2", dashboard())).toBe(true);
  });

  it("does not show for a closed or unavailable campaign", () => {
    expect(shouldShowReferralNotice("user-1", { ...dashboard(), canInvite: false })).toBe(false);
    expect(shouldShowReferralNotice("user-1", { ...dashboard(), campaign: null })).toBe(false);
  });
});
