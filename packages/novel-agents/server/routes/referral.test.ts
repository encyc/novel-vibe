import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { handleRequest } from "../../server.js";
import { documentWrites } from "../../lib/document-write-coordinator.js";
import { signTestToken } from "../../lib/auth.js";
import { SessionTurnInterruptedError } from "../../session/service.js";
import { SessionDomainError } from "../../session/types.js";
import { sha256Content } from "../../lib/storage.js";
import { VersionedDocumentWriter } from "../../document-version/service.js";
import { parseFrontmatter } from "../../lib/frontmatter.js";
import { DEFAULT_USER, mockBody, mockDbInstance, mockReq, mockRes, resetServerMocks } from "../test-kit.js";

vi.mock("../../lib/agent-resources/runtime.js", () => import("../test-kit.js").then((k) => k.agentResourcesMockFactory()));
vi.mock("../../model-runtime/system-resolver.js", () => import("../test-kit.js").then((k) => k.modelResolverMockFactory()));
vi.mock("../../auth/api-token-repository.js", () => import("../test-kit.js").then((k) => k.apiTokenRepoMockFactory()));
vi.mock("../../lib/db.js", () => import("../test-kit.js").then((k) => k.dbMockFactory()));
vi.mock("../../lib/storage.js", (importOriginal) => import("../test-kit.js").then((k) => k.storageMockFactory(importOriginal)));
vi.mock("../../agents.js", () => import("../test-kit.js").then((k) => k.agentsMockFactory()));
vi.mock("../../session/service.js", () => import("../test-kit.js").then((k) => k.sessionServiceMockFactory()));
vi.mock("../../lib/frontmatter.js", () => import("../test-kit.js").then((k) => k.frontmatterMockFactory()));
vi.mock("../../lib/skills.js", () => import("../test-kit.js").then((k) => k.skillsMockFactory()));
vi.mock("../../skills/runtime.js", () => import("../test-kit.js").then((k) => k.skillReviewMockFactory()));

beforeEach(async () => {
  await resetServerMocks();
});

describe("server referral", () => {
  it("previews referral codes anonymously without inviter identity", async () => {
      mockDbInstance.previewReferralCode.mockResolvedValue({
        valid: true, code: "ABCD2345", reward_days: 10, purchase_window_days: 30,
        binding_ends_at: "2026-09-01T00:00:00Z", inviter_user_id: "secret",
      });
      const req = mockReq({ method: "GET", url: "/api/referrals/preview/abcd2345", headers: {} });
      const res = mockRes();
      await handleRequest(req as any, res as any);
      const body = JSON.parse((res.end as any).mock.calls[0][0]);
      expect(body).toMatchObject({ valid: true, code: "ABCD2345", rewardDays: 10 });
      expect(body).not.toHaveProperty("inviter_user_id");
    });

  it("requires the server-side administrator role for campaign updates", async () => {
      mockDbInstance.isCommunityAdmin.mockResolvedValue(false);
      const deniedReq = mockReq({ method: "PATCH", url: "/api/referrals/admin/campaign" });
      mockBody(deniedReq, { bindingEndsAt: "2026-09-01T00:00:00Z", reason: "extend", user_id: "admin" });
      const deniedRes = mockRes();
      await handleRequest(deniedReq as any, deniedRes as any);
      expect(deniedRes.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
      expect(mockDbInstance.updateReferralCampaign).not.toHaveBeenCalled();

      mockDbInstance.isCommunityAdmin.mockResolvedValue(true);
      mockDbInstance.updateReferralCampaign.mockResolvedValue({ binding_ends_at: "2026-09-01T00:00:00Z" });
      const updateReq = mockReq({ method: "PATCH", url: "/api/referrals/admin/campaign" });
      mockBody(updateReq, { bindingEndsAt: "2026-09-01T00:00:00Z", reason: "extend", user_id: "attacker" });
      const updateRes = mockRes();
      await handleRequest(updateReq as any, updateRes as any);
      expect(mockDbInstance.updateReferralCampaign).toHaveBeenCalledWith(expect.objectContaining({
        adminUserId: DEFAULT_USER, reason: "extend",
      }));
    });
});
