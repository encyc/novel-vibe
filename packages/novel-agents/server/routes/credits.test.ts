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
import { DEFAULT_USER, mockDbInstance, mockRawBody, mockReq, mockRes, resetServerMocks } from "../test-kit.js";

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

describe("server credits", () => {
  it("serves the authenticated credit summary", async () => {
      const summaryRes = mockRes();
      await handleRequest(mockReq({ url: "/api/credits/summary" }) as any, summaryRes as any);
      expect(JSON.parse((summaryRes.end as any).mock.calls[0][0])).toEqual({
        balance: 10, totalGranted: 20, totalConsumed: 10, level: 0, levelName: "新用户",
      });
    });

  it("validates activity and ledger query parameters", async () => {
      const activityRes = mockRes();
      await handleRequest(mockReq({ url: "/api/credits/activity?year=nope&timezone=Bad%2FZone" }) as any, activityRes as any);
      expect(activityRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));

      const ledgerRes = mockRes();
      await handleRequest(mockReq({ url: "/api/credits/transactions?type=invalid" }) as any, ledgerRes as any);
      expect(ledgerRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

  it("accepts a signed public Z-Pay callback without bearer auth", async () => {
      process.env.ZPAY_PID = "pid-1";
      process.env.ZPAY_KEY = "secret";
      mockDbInstance.getPurchase.mockResolvedValue({
        out_trade_no: "NOVEL123", user_id: DEFAULT_USER, price_cents: 2000, payment_status: "pending",
      });
      mockDbInstance.completeCreditPurchase.mockResolvedValue({ payment_status: "completed", new_balance: 200 });
      const { generateSign } = await import("../../lib/zpay.js");
      const fields: Record<string, string> = {
        pid: "pid-1", out_trade_no: "NOVEL123", trade_no: "zpay-1",
        trade_status: "TRADE_SUCCESS", money: "20.00", param: DEFAULT_USER, sign_type: "MD5",
      };
      fields.sign = generateSign(fields, "secret");
      const req = mockReq({ method: "POST", url: "/api/payments/zpay/notify", headers: { "content-type": "application/x-www-form-urlencoded" } });
      mockRawBody(req, new URLSearchParams(fields).toString());
      const res = mockRes();
      await handleRequest(req as any, res as any);
      expect(res.end).toHaveBeenCalledWith("success");
      expect(mockDbInstance.completeCreditPurchase).toHaveBeenCalledWith("NOVEL123", "zpay-1");
    });
});
