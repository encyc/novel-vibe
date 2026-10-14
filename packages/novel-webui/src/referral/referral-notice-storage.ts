import type { ReferralDashboard } from "../types";

const STORAGE_PREFIX = "novel-vibe:referral-notice-dismissed";

export function referralNoticeStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}:${userId}`;
}

export function shouldShowReferralNotice(
  userId: string,
  dashboard: ReferralDashboard,
  storage: Storage = window.localStorage,
): boolean {
  const deadline = dashboard.campaign?.bindingEndsAt;
  return Boolean(userId && dashboard.canInvite && deadline
    && storage.getItem(referralNoticeStorageKey(userId)) !== deadline);
}

export function dismissReferralNotice(
  userId: string,
  bindingEndsAt: string,
  storage: Storage = window.localStorage,
): void {
  storage.setItem(referralNoticeStorageKey(userId), bindingEndsAt);
}
