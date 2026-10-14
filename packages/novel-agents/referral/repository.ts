import type { DbClient } from "../lib/db.js";
import type { ReferralDataSource } from "./types.js";

export class ReferralRepository implements ReferralDataSource {
  constructor(private readonly db: Pick<DbClient,
    | "previewReferralCode" | "getReferralDashboard" | "isCommunityAdmin"
    | "updateReferralCampaign" | "getReferralAdminMetrics" | "listReferralAdminBindings"
    | "reviewReferralBinding"
  >) {}

  previewReferralCode(code: string) {
    return this.db.previewReferralCode(code);
  }

  getReferralDashboard(userId: string) {
    return this.db.getReferralDashboard(userId);
  }

  isCommunityAdmin(userId: string) { return this.db.isCommunityAdmin(userId); }
  updateReferralCampaign(input: Parameters<ReferralDataSource["updateReferralCampaign"]>[0]) {
    return this.db.updateReferralCampaign(input);
  }
  getReferralAdminMetrics() { return this.db.getReferralAdminMetrics(); }
  listReferralAdminBindings(input: Parameters<ReferralDataSource["listReferralAdminBindings"]>[0]) {
    return this.db.listReferralAdminBindings(input);
  }
  reviewReferralBinding(input: Parameters<ReferralDataSource["reviewReferralBinding"]>[0]) {
    return this.db.reviewReferralBinding(input);
  }
}
