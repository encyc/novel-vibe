import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import { LocaleProvider } from "../i18n/LocaleProvider";
import type { ReferralDashboard } from "../types";
import { ReferralCampaignNotice } from "./ReferralCampaignNotice";
import { dismissReferralNotice, referralNoticeStorageKey } from "./referral-notice-storage";

const eligible = {
  code: "ABCD2345",
  shareUrl: "https://app.example/login?invite=ABCD2345",
  canInvite: true,
  campaign: { bindingEndsAt: "2026-09-01T00:00:00.000Z", rewardDays: 10, maxSlots: 10 },
  counts: { successful: 2, pending: 1, remaining: 7 },
  invitations: [],
  inviteeBinding: null,
  rewards: [],
} satisfies ReferralDashboard;

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current location">{location.pathname}{location.search}</output>;
}

function renderNotice(userId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={["/projects"]}>
      <LocaleProvider>
        <QueryClientProvider client={client}>
          <ReferralCampaignNotice userId={userId} />
          <LocationProbe />
        </QueryClientProvider>
      </LocaleProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem("novel-vibe:interface-locale", "zh-CN");
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReferralCampaignNotice", () => {
  it("shows eligible campaign details and dismisses after copying", async () => {
    vi.spyOn(api, "getReferralDashboard").mockResolvedValue(eligible);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    renderNotice("user-1");

    expect(await screen.findByRole("dialog", { name: "邀请好友，双方得会员" })).toBeInTheDocument();
    expect(screen.getByText(/双方各得 10 天会员/)).toBeInTheDocument();
    expect(screen.getByText(/剩余 7 个邀请名额/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "复制邀请链接" }));
    expect(writeText).toHaveBeenCalledWith(eligible.shareUrl);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(localStorage.getItem(referralNoticeStorageKey("user-1"))).toBe(eligible.campaign.bindingEndsAt);
  });

  it("keeps the dialog open when copying fails", async () => {
    vi.spyOn(api, "getReferralDashboard").mockResolvedValue(eligible);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    renderNotice("user-1");
    await userEvent.click(await screen.findByRole("button", { name: "复制邀请链接" }));

    expect(await screen.findByRole("status")).toHaveTextContent("复制失败，请重试。");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(localStorage.getItem(referralNoticeStorageKey("user-1"))).toBeNull();
  });

  it("dismisses with the secondary action", async () => {
    vi.spyOn(api, "getReferralDashboard").mockResolvedValue(eligible);
    renderNotice("user-1");

    await userEvent.click(await screen.findByRole("button", { name: "稍后再说" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(referralNoticeStorageKey("user-1"))).toBe(eligible.campaign.bindingEndsAt);
  });

  it("opens complete campaign details in the referral profile section", async () => {
    vi.spyOn(api, "getReferralDashboard").mockResolvedValue(eligible);
    renderNotice("user-1");

    await userEvent.click(await screen.findByRole("button", { name: "查看完整规则与邀请进度" }));

    expect(screen.getByLabelText("current location")).toHaveTextContent("/profile?section=referral");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(referralNoticeStorageKey("user-1"))).toBe(eligible.campaign.bindingEndsAt);
  });

  it("skips ineligible, dismissed, and failed campaign requests", async () => {
    const referral = vi.spyOn(api, "getReferralDashboard").mockResolvedValue({ ...eligible, canInvite: false });
    const first = renderNotice("user-1");
    await waitFor(() => expect(referral).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    first.unmount();

    dismissReferralNotice("user-2", eligible.campaign.bindingEndsAt);
    referral.mockResolvedValue(eligible);
    const second = renderNotice("user-2");
    await waitFor(() => expect(referral).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    second.unmount();

    referral.mockRejectedValue(new Error("offline"));
    renderNotice("user-3");
    await waitFor(() => expect(referral).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses English copy and locale-aware dates", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "en");
    await i18n.changeLanguage("en");
    vi.spyOn(api, "getReferralDashboard").mockResolvedValue(eligible);

    renderNotice("user-1");

    expect(await screen.findByRole("dialog", { name: "Invite friends, reward both" })).toBeInTheDocument();
    expect(screen.getByText(/Sep 1, 2026/)).toBeInTheDocument();
  });
});
