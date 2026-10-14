import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ReferralAdminPage } from "./ReferralAdminPage";

vi.mock("../api/client", () => ({ api: {
  getReferralAdminMetrics: vi.fn(), listReferralAdminBindings: vi.fn(),
  updateReferralCampaign: vi.fn(), reviewReferralBinding: vi.fn(),
} }));

describe("ReferralAdminPage", () => {
  it("closes new invitations by updating only the campaign deadline", async () => {
    vi.mocked(api.getReferralAdminMetrics).mockResolvedValue({
      campaign: { id: "c1", slug: "campaign", binding_ends_at: "2026-09-30T00:00:00Z", purchase_window_days: 30, reward_days: 10, max_slots_per_inviter: 10 },
      totals: { landings: 10, verified_emails: 5, bindings: 4, pending: 2, risk_pending: 1, expired: 0, successful: 1, reward_days: 20 },
    });
    vi.mocked(api.listReferralAdminBindings).mockResolvedValue([]);
    vi.mocked(api.updateReferralCampaign).mockResolvedValue({ campaign: {} as never });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<MemoryRouter><QueryClientProvider client={client}><ReferralAdminPage /></QueryClientProvider></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: "关闭新邀请" }));
    expect(api.updateReferralCampaign).toHaveBeenCalledWith(expect.objectContaining({
      bindingEndsAt: expect.any(String), reason: "手动关闭活动",
    }));
  });
});
