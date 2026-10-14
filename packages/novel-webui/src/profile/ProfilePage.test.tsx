import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { AppProviders } from "../app/AppProviders";
import { ProfilePage } from "./ProfilePage";

function renderPage(path = "/profile") {
  window.history.replaceState({}, "", path);
  return render(
    <AppProviders>
      <ProfilePage onSignedOut={vi.fn()} user={{ id: "user-1", email: "writer@example.com" }} />
    </AppProviders>,
  );
}

describe("ProfilePage", () => {
  beforeEach(() => {
    vi.spyOn(api, "getProfile").mockResolvedValue({
      id: "user-1",
      email: "writer@example.com",
      displayName: "墨白",
      avatarUrl: null,
      locale: "zh-CN",
    });
    vi.spyOn(api, "getCreditSummary").mockResolvedValue({ balance: 10, totalGranted: 20, totalConsumed: 10, level: 1, levelName: "新芽" });
    vi.spyOn(api, "getCreditActivity").mockResolvedValue([]);
    vi.spyOn(api, "listCreditTransactions").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, "listCreditPackages").mockResolvedValue([]);
    vi.spyOn(api, "getMembershipPlans").mockResolvedValue([]);
    vi.spyOn(api, "getMembershipStatus").mockResolvedValue({ active: false, planName: null, expiresAt: null, features: [] });
    vi.spyOn(api, "getReferralDashboard").mockResolvedValue({
      code: "ABCD2345",
      shareUrl: "https://example.test/login?invite=ABCD2345",
      canInvite: false,
      campaign: { bindingEndsAt: "2026-09-30T00:00:00Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 0, pending: 0, remaining: 10 },
      invitations: [],
      rewards: [],
      inviteeBinding: null,
    });
    vi.spyOn(api, "getMembershipPurchase").mockResolvedValue({ orderNo: "MC-1", status: "failed" });
    vi.spyOn(api, "getCreditPurchase").mockResolvedValue({ orderNo: "CR-1", status: "failed" });
    vi.spyOn(api, "logout").mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("renders only the default profile panel and switches from desktop navigation", async () => {
    renderPage();

    const profilePanel = await screen.findByRole("region", { name: "个人资料" });
    expect(await within(profilePanel).findByRole("button", { name: "编辑资料" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "额度概览" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "额度概览" }));
    expect(await screen.findByRole("region", { name: "额度概览" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "个人资料" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "额度概览" })).toHaveAttribute("aria-current", "page");
  });

  it("shares active state with the mobile selector", async () => {
    renderPage();
    await screen.findByRole("region", { name: "个人资料" });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "选择个人中心栏目" }), "records");
    expect(await screen.findByRole("region", { name: "账目记录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "账目记录" })).toHaveAttribute("aria-current", "page");
  });

  it("derives eligible campaign annotations from the referral dashboard", async () => {
    vi.mocked(api.getReferralDashboard).mockResolvedValue({
      code: "ABCD2345",
      shareUrl: "https://example.test/login?invite=ABCD2345",
      canInvite: true,
      campaign: { bindingEndsAt: "2026-09-30T00:00:00Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 0, pending: 0, remaining: 10 },
      invitations: [],
      rewards: [],
      inviteeBinding: null,
    });
    renderPage();

    expect(await screen.findByText("双方 +10 天")).toBeInTheDocument();
    expect(screen.getByText("邀请活动：双方 +10 天")).toBeInTheDocument();
  });

  it.each(["capacity_full", "campaign_closed"] as const)("hides inactive %s campaign annotations", async (unavailableReason) => {
    vi.mocked(api.getReferralDashboard).mockResolvedValue({
      code: "ABCD2345",
      shareUrl: "https://example.test/login?invite=ABCD2345",
      canInvite: false,
      unavailableReason,
      campaign: { bindingEndsAt: "2026-09-30T00:00:00Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 0, pending: 0, remaining: 0 },
      invitations: [],
      rewards: [],
      inviteeBinding: null,
    });
    renderPage();

    await screen.findByRole("region", { name: "个人资料" });
    expect(screen.queryByText("双方 +10 天")).not.toBeInTheDocument();
    expect(screen.queryByText("开通会员后可邀请")).not.toBeInTheDocument();
  });

  it("derives the membership campaign annotation for an inactive inviter", async () => {
    vi.mocked(api.getReferralDashboard).mockResolvedValue({
      code: "ABCD2345",
      shareUrl: "https://example.test/login?invite=ABCD2345",
      canInvite: false,
      unavailableReason: "inviter_inactive",
      campaign: { bindingEndsAt: "2026-09-30T00:00:00Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 0, pending: 0, remaining: 10 },
      invitations: [],
      rewards: [],
      inviteeBinding: null,
    });
    renderPage();

    expect(await screen.findByText("开通会员后可邀请")).toBeInTheDocument();
    expect(screen.getByText("邀请活动：开通会员后可邀请")).toBeInTheDocument();
  });

  it("keeps referral campaign query errors out of the profile navigation", async () => {
    vi.mocked(api.getReferralDashboard).mockRejectedValue(new Error("offline"));
    renderPage();

    await screen.findByRole("region", { name: "个人资料" });
    await waitFor(() => expect(api.getReferralDashboard).toHaveBeenCalled());
    expect(screen.queryByText("双方 +10 天")).not.toBeInTheDocument();
    expect(screen.queryByText("开通会员后可邀请")).not.toBeInTheDocument();
  });

  it("opens a valid profile section deep link", async () => {
    renderPage("/profile?section=referral");

    expect(await screen.findByRole("region", { name: "邀请奖励" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "邀请奖励" })).toHaveAttribute("aria-current", "page");
  });

  it("moves an inactive inviter from referral details to membership", async () => {
    vi.mocked(api.getReferralDashboard).mockResolvedValue({
      code: "ABCD2345",
      shareUrl: "https://example.test/login?invite=ABCD2345",
      canInvite: false,
      unavailableReason: "inviter_inactive",
      campaign: { bindingEndsAt: "2026-09-30T00:00:00Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 0, pending: 0, remaining: 10 },
      invitations: [],
      rewards: [],
      inviteeBinding: null,
    });
    renderPage("/profile?section=referral");

    await userEvent.click(await screen.findByRole("button", { name: "查看会员计划" }));
    expect(await screen.findByRole("region", { name: "会员计划" })).toBeInTheDocument();
  });

  it("falls back to profile identity for an invalid section", async () => {
    renderPage("/profile?section=unknown");

    expect(await screen.findByRole("region", { name: "个人资料" })).toBeInTheDocument();
  });

  it("gives a payment return priority over a section deep link", async () => {
    renderPage("/profile?section=referral&out_trade_no=MC-1");

    expect(await screen.findByRole("region", { name: "会员计划" })).toBeInTheDocument();
    await waitFor(() => expect(api.getMembershipPurchase).toHaveBeenCalledWith("MC-1"));
  });

  it("opens membership for a membership payment return", async () => {
    renderPage("/profile?out_trade_no=MC-1");

    expect(await screen.findByRole("region", { name: "会员计划" })).toBeInTheDocument();
    await waitFor(() => expect(api.getMembershipPurchase).toHaveBeenCalledWith("MC-1"));
  });

  it("opens top up for a Credit payment return", async () => {
    renderPage("/profile?order_no=CR-1");

    expect(await screen.findByRole("region", { name: "充值额度" })).toBeInTheDocument();
    await waitFor(() => expect(api.getCreditPurchase).toHaveBeenCalledWith("CR-1"));
  });
});
