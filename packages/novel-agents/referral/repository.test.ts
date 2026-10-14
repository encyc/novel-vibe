import { describe, expect, it, vi } from "vitest";
import { ReferralRepository } from "./repository.js";

describe("ReferralRepository", () => {
  it("delegates caller-scoped referral RPCs", async () => {
    const db = {
      previewReferralCode: vi.fn(), getReferralDashboard: vi.fn(), isCommunityAdmin: vi.fn(),
      updateReferralCampaign: vi.fn(), getReferralAdminMetrics: vi.fn(),
      listReferralAdminBindings: vi.fn(), reviewReferralBinding: vi.fn(),
    };
    const repo = new ReferralRepository(db as never);
    await repo.previewReferralCode("ABCD2345");
    await repo.getReferralDashboard("u1");
    expect(db.previewReferralCode).toHaveBeenCalledWith("ABCD2345");
    expect(db.getReferralDashboard).toHaveBeenCalledWith("u1");
    await repo.updateReferralCampaign({ bindingEndsAt: "date", adminUserId: "a", reason: "r" });
    expect(db.updateReferralCampaign).toHaveBeenCalled();
  });
});
