import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { LocaleProvider } from "../i18n/LocaleProvider";
import { ReferralCard } from "./ReferralCard";

vi.mock("../api/client", () => ({ api: { getReferralDashboard: vi.fn() } }));

function renderReferralCard(props: ComponentProps<typeof ReferralCard> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocaleProvider>
      <QueryClientProvider client={client}><ReferralCard {...props} /></QueryClientProvider>
    </LocaleProvider>,
  );
}

afterEach(cleanup);

describe("ReferralCard", () => {
  it("shows counts, masked history, and copies only the server share URL", async () => {
    vi.mocked(api.getReferralDashboard).mockResolvedValue({
      code: "ABCD2345", shareUrl: "https://app.test/login?invite=ABCD2345", canInvite: true,
      campaign: { bindingEndsAt: "2026-09-30T00:00:00Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 1, pending: 2, remaining: 7 },
      invitations: [{ id: "b1", maskedEmail: "w***r@example.com", boundAt: "2026-08-18T00:00:00Z", purchaseDeadline: "2026-09-17T00:00:00Z", status: "pending" }],
      inviteeBinding: null, rewards: [],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderReferralCard();
    expect(await screen.findByRole("heading", { name: "邀请好友，双方得会员" })).toBeInTheDocument();
    expect(screen.getByText(/2026年9月30日/)).toBeInTheDocument();
    expect(await screen.findByText("w***r@example.com")).toBeInTheDocument();
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "复制邀请链接" }));
    expect(writeText).toHaveBeenCalledWith("https://app.test/login?invite=ABCD2345");
  });

  it("hands inactive inviters to membership", async () => {
    vi.mocked(api.getReferralDashboard).mockResolvedValue({
      code: "ABCD2345",
      shareUrl: "https://app.test/login?invite=ABCD2345",
      canInvite: false,
      unavailableReason: "inviter_inactive",
      campaign: { bindingEndsAt: "2026-09-30T00:00:00Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 0, pending: 0, remaining: 10 },
      invitations: [],
      inviteeBinding: null,
      rewards: [],
    });
    const onOpenMembership = vi.fn();
    renderReferralCard({ onOpenMembership });

    await userEvent.click(await screen.findByRole("button", { name: "查看会员计划" }));
    expect(onOpenMembership).toHaveBeenCalledOnce();
  });
});
