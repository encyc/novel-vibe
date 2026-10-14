import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateReferralCode, maskInviteeEmail, ReferralService } from "./service.js";

describe("ReferralService", () => {
  const repo = {
    previewReferralCode: vi.fn(), getReferralDashboard: vi.fn(), isCommunityAdmin: vi.fn(),
    updateReferralCampaign: vi.fn(), getReferralAdminMetrics: vi.fn(),
    listReferralAdminBindings: vi.fn(), reviewReferralBinding: vi.fn(),
  };
  const service = new ReferralService(repo, "https://app.example.com/");
  beforeEach(() => vi.clearAllMocks());

  it("generates unambiguous eight-character codes", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateReferralCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("normalizes a preview without exposing inviter identity", async () => {
    repo.previewReferralCode.mockResolvedValue({ valid: true, code: "ABCD2345", reward_days: 10,
      purchase_window_days: 30, binding_ends_at: "2026-09-01T00:00:00Z", inviter_user_id: "secret" });
    await expect(service.preview(" abcd2345 ")).resolves.toEqual({
      valid: true, code: "ABCD2345", rewardDays: 10, purchaseWindowDays: 30,
      bindingEndsAt: "2026-09-01T00:00:00Z",
    });
  });

  it("masks invitees and builds a server-controlled share URL", async () => {
    repo.getReferralDashboard.mockResolvedValue({ code: "ABCD2345", can_invite: true,
      campaign: { binding_ends_at: "2026-09-01T00:00:00Z", reward_days: 10, max_slots: 10 },
      counts: { successful: 1, pending: 2, remaining: 7 },
      invitations: [{ id: "b1", email: "writer@example.com", bound_at: "b", purchase_deadline: "d", status: "pending" }],
      rewards: [] });
    const dashboard = await service.dashboard("u1");
    expect(dashboard.shareUrl).toBe("https://app.example.com/login?invite=ABCD2345");
    expect(dashboard.invitations[0].maskedEmail).toBe("w***r@example.com");
    expect(maskInviteeEmail("a@x.cn")).toBe("a***@x.cn");
  });

  it("requires an administrator and normalizes deadline updates", async () => {
    repo.isCommunityAdmin.mockResolvedValue(false);
    await expect(service.updateCampaign("user", {
      bindingEndsAt: "2026-09-01T00:00:00+08:00", reason: " 延长活动 ",
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED", status: 403 });
    expect(repo.updateReferralCampaign).not.toHaveBeenCalled();

    repo.isCommunityAdmin.mockResolvedValue(true);
    repo.updateReferralCampaign.mockResolvedValue({ binding_ends_at: "2026-08-31T16:00:00.000Z" });
    await service.updateCampaign("admin", {
      bindingEndsAt: "2026-09-01T00:00:00+08:00", reason: " 延长活动 ",
    });
    expect(repo.updateReferralCampaign).toHaveBeenCalledWith({
      bindingEndsAt: "2026-08-31T16:00:00.000Z", adminUserId: "admin", reason: "延长活动",
    });
  });
});
