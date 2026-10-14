import { randomBytes } from "node:crypto";
import type {
  ReferralDashboard, ReferralDataSource, ReferralPreview, ReferralUnavailableReason,
} from "./types.js";
import { ReferralError } from "./types.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateReferralCode(): string {
  let result = "";
  const acceptedLimit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  while (result.length < 8) {
    for (const value of randomBytes(16)) {
      if (value >= acceptedLimit) continue;
      result += CODE_ALPHABET[value % CODE_ALPHABET.length];
      if (result.length === 8) break;
    }
  }
  return result;
}

export function normalizeReferralCode(value: string): string {
  return value.trim().toUpperCase();
}

export function maskInviteeEmail(value: string): string {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return "***";
  const local = value.slice(0, separator);
  const domain = value.slice(separator);
  if (local.length === 1) return `${local}***${domain}`;
  return `${local[0]}***${local.at(-1)}${domain}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class ReferralService {
  constructor(private readonly repo: ReferralDataSource, private readonly publicOrigin: string) {}

  async preview(rawCode: string): Promise<ReferralPreview> {
    const code = normalizeReferralCode(rawCode);
    const row = await this.repo.previewReferralCode(code);
    return {
      valid: row?.valid === true,
      code: stringValue(row?.code) || code,
      rewardDays: numberValue(row?.reward_days),
      purchaseWindowDays: numberValue(row?.purchase_window_days),
      bindingEndsAt: stringValue(row?.binding_ends_at) || null,
      ...(row?.unavailable_reason
        ? { unavailableReason: row.unavailable_reason as ReferralUnavailableReason }
        : {}),
    };
  }

  async dashboard(userId: string): Promise<ReferralDashboard> {
    const row = await this.repo.getReferralDashboard(userId) ?? {};
    const campaign = row.campaign as Record<string, unknown> | null | undefined;
    const counts = (row.counts ?? {}) as Record<string, unknown>;
    const invitations = Array.isArray(row.invitations) ? row.invitations as Record<string, unknown>[] : [];
    const rewards = Array.isArray(row.rewards) ? row.rewards as Record<string, unknown>[] : [];
    const code = stringValue(row.code);
    return {
      code,
      shareUrl: `${this.publicOrigin.replace(/\/$/, "")}/login?invite=${encodeURIComponent(code)}`,
      canInvite: row.can_invite === true,
      ...(row.unavailable_reason ? { unavailableReason: row.unavailable_reason as ReferralUnavailableReason } : {}),
      campaign: campaign ? {
        bindingEndsAt: stringValue(campaign.binding_ends_at),
        rewardDays: numberValue(campaign.reward_days),
        maxSlots: numberValue(campaign.max_slots),
      } : null,
      counts: {
        successful: numberValue(counts.successful), pending: numberValue(counts.pending),
        remaining: numberValue(counts.remaining),
      },
      invitations: invitations.map((invitation) => ({
        id: stringValue(invitation.id), maskedEmail: maskInviteeEmail(stringValue(invitation.email)),
        boundAt: stringValue(invitation.bound_at), purchaseDeadline: stringValue(invitation.purchase_deadline),
        status: invitation.status as ReferralDashboard["invitations"][number]["status"],
      })),
      inviteeBinding: row.invitee_binding ? {
        status: stringValue((row.invitee_binding as Record<string, unknown>).status),
        purchaseDeadline: stringValue((row.invitee_binding as Record<string, unknown>).purchase_deadline),
      } : null,
      rewards: rewards.map((reward) => ({
        role: reward.role as "inviter" | "invitee", days: numberValue(reward.days),
        grantedAt: stringValue(reward.granted_at), expiresAt: stringValue(reward.expires_at),
      })),
    };
  }

  async requireAdmin(userId: string): Promise<void> {
    if (!await this.repo.isCommunityAdmin(userId)) {
      throw new ReferralError("ADMIN_REQUIRED", 403, "Referral campaign administrator required");
    }
  }

  async adminMetrics(userId: string) {
    await this.requireAdmin(userId);
    return await this.repo.getReferralAdminMetrics() ?? {};
  }

  async updateCampaign(userId: string, input: { bindingEndsAt: string; reason: string }) {
    await this.requireAdmin(userId);
    const deadline = new Date(input.bindingEndsAt);
    if (!Number.isFinite(deadline.getTime()) || !input.reason.trim()) {
      throw new ReferralError("INVALID_CAMPAIGN_UPDATE", 400, "A valid deadline and reason are required");
    }
    return this.repo.updateReferralCampaign({
      bindingEndsAt: deadline.toISOString(), adminUserId: userId, reason: input.reason.trim(),
    });
  }

  async adminBindings(userId: string, input: { search?: string; cursor?: string; limit?: number }) {
    await this.requireAdmin(userId);
    return this.repo.listReferralAdminBindings({
      search: input.search?.trim() || undefined,
      cursor: input.cursor,
      limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
    });
  }

  async review(userId: string, bindingId: string, decision: "approve" | "reject", reason: string) {
    await this.requireAdmin(userId);
    if (!bindingId || !reason.trim()) {
      throw new ReferralError("INVALID_REFERRAL_REVIEW", 400, "A binding and reason are required");
    }
    return this.repo.reviewReferralBinding({
      bindingId, decision, adminUserId: userId, reason: reason.trim(),
    });
  }
}
