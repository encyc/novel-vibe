export type ReferralUnavailableReason =
  | "campaign_closed"
  | "inviter_inactive"
  | "capacity_full"
  | "invalid_code";

export interface ReferralPreview {
  valid: boolean;
  code: string;
  rewardDays: number;
  purchaseWindowDays: number;
  bindingEndsAt: string | null;
  unavailableReason?: ReferralUnavailableReason;
}

export interface ReferralDashboard {
  code: string;
  shareUrl: string;
  canInvite: boolean;
  unavailableReason?: ReferralUnavailableReason;
  campaign: { bindingEndsAt: string; rewardDays: number; maxSlots: number } | null;
  counts: { successful: number; pending: number; remaining: number };
  invitations: Array<{
    id: string;
    maskedEmail: string;
    boundAt: string;
    purchaseDeadline: string;
    status: "pending" | "risk_pending" | "successful" | "expired" | "rejected";
  }>;
  inviteeBinding: { status: string; purchaseDeadline: string } | null;
  rewards: Array<{ role: "inviter" | "invitee"; days: number; grantedAt: string; expiresAt: string }>;
}

export interface ReferralDataSource {
  previewReferralCode(code: string): Promise<Record<string, unknown> | null>;
  getReferralDashboard(userId: string): Promise<Record<string, unknown> | null>;
  isCommunityAdmin(userId: string): Promise<boolean>;
  updateReferralCampaign(input: {
    bindingEndsAt: string; adminUserId: string; reason: string;
  }): Promise<Record<string, unknown> | null>;
  getReferralAdminMetrics(): Promise<Record<string, unknown> | null>;
  listReferralAdminBindings(input: {
    search?: string; cursor?: string; limit?: number;
  }): Promise<Record<string, unknown>[]>;
  reviewReferralBinding(input: {
    bindingId: string; decision: "approve" | "reject"; adminUserId: string; reason: string;
  }): Promise<Record<string, unknown> | null>;
}

export class ReferralError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "ReferralError";
  }
}
