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
import { DEFAULT_USER, apiTokenRows, authState, mockApiTokenRepository, mockBody, mockDbInstance, mockNoBody, mockRawBody, mockReq, mockRes, mockStorageInstance, resetServerMocks } from "../test-kit.js";

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

describe("server profile", () => {
  it("sends and verifies registration codes without authentication", async () => {
      const sendReq = mockReq({
        method: "POST", url: "/api/auth/registration/code",
        headers: { "x-interface-locale": "zh-CN", "x-registration-client-ip": "203.0.113.8" },
      });
      mockBody(sendReq, { email: "User@example.com" });
      const sendRes = mockRes();
      await handleRequest(sendReq as any, sendRes as any);
      expect(sendRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockDbInstance.requestRegistrationCode).toHaveBeenCalledWith(expect.objectContaining({ email: "user@example.com" }));

      const verifyReq = mockReq({ method: "POST", url: "/api/auth/registration/verify", headers: {} });
      mockBody(verifyReq, { email: "user@example.com", code: "123456" });
      const verifyRes = mockRes();
      await handleRequest(verifyReq as any, verifyRes as any);
      expect(JSON.parse((verifyRes.end as any).mock.calls[0][0])).toMatchObject({ expiresInSeconds: 900 });
    });

  it("finalizes registration with the bearer-derived identity", async () => {
      const req = mockReq({ method: "POST", url: "/api/auth/registration/finalize" });
      mockBody(req, { reservation: "opaque", userId: "attacker" });
      const res = mockRes();
      await handleRequest(req as any, res as any);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockDbInstance.finalizeRegistrationReservation).toHaveBeenCalledWith(expect.objectContaining({
        userId: DEFAULT_USER, email: `${DEFAULT_USER}@example.com`,
      }));
    });

  it("creates, lists, and revokes only the authenticated owner's API tokens", async () => {
      const createReq = mockReq({ method: "POST", url: "/api/profile/tokens" });
      mockBody(createReq, {
        name: "CLI",
        lifetimeDays: 30,
        scopes: ["projects:read", "documents:read"],
        user_id: "forged-owner",
      });
      const createRes = mockRes();
      await handleRequest(createReq as any, createRes as any);
      expect(createRes.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
      const created = JSON.parse((createRes.end as any).mock.calls[0][0]);
      expect(created.token).toMatch(/^lingqi_/);
      expect(created).not.toHaveProperty("secret_hash");
      expect(mockApiTokenRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ ownerId: DEFAULT_USER }));

      const listRes = mockRes();
      await handleRequest(mockReq({ url: "/api/profile/tokens" }) as any, listRes as any);
      const listed = JSON.parse((listRes.end as any).mock.calls[0][0]);
      expect(listed).toEqual({ tokens: [expect.objectContaining({ id: created.id, user_id: DEFAULT_USER })] });
      expect(JSON.stringify(listed)).not.toContain(created.token);
      expect(JSON.stringify(listed)).not.toContain("secret_hash");

      const deleteReq = mockReq({ method: "DELETE", url: `/api/profile/tokens/${created.id}` });
      mockNoBody(deleteReq);
      const deleteRes = mockRes();
      await handleRequest(deleteReq as any, deleteRes as any);
      expect(deleteRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(JSON.parse((deleteRes.end as any).mock.calls[0][0])).toEqual({ ok: true });
      expect(JSON.stringify((deleteRes.end as any).mock.calls[0][0])).not.toContain(created.token);
    });

  it("supports scope presets without allowing nondelegable scopes", async () => {
      const req = mockReq({ method: "POST", url: "/api/profile/tokens" });
      mockBody(req, { name: "Reader", lifetimeDays: 90, presets: ["read"] });
      const res = mockRes();
      await handleRequest(req as any, res as any);
      expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
      expect(mockApiTokenRepository.insert).toHaveBeenCalledWith(expect.objectContaining({
        scopes: expect.arrayContaining(["projects:read", "documents:read", "billing:read"]),
      }));
    });

  it("returns the same not-found response for missing and cross-owner token revocation", async () => {
      apiTokenRows.push({ id: "other-token", user_id: "other-user", revoked_at: null, secret_hash: "hidden" });
      for (const id of ["missing-token", "other-token"]) {
        const req = mockReq({ method: "DELETE", url: `/api/profile/tokens/${id}` });
        mockNoBody(req);
        const res = mockRes();
        await handleRequest(req as any, res as any);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
        expect(JSON.parse((res.end as any).mock.calls[0][0])).toEqual({
          error: { code: "API_TOKEN_NOT_FOUND", message: "API token not found" },
        });
      }
    });

  it("returns the non-leaking not-found response for a malformed encoded token id", async () => {
      const req = mockReq({ method: "DELETE", url: "/api/profile/tokens/%E0%A4%A" });
      mockNoBody(req);
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toEqual({
        error: { code: "API_TOKEN_NOT_FOUND", message: "API token not found" },
      });
      expect(mockApiTokenRepository.revokeOwned).not.toHaveBeenCalled();
    });

  it("requires an InsForge user JWT for API token management", async () => {
      for (const headers of [{}, { authorization: "Bearer lingqi_public_secret" }]) {
        const res = mockRes();
        await handleRequest(mockReq({ url: "/api/profile/tokens", headers }) as any, res as any);
        expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
      }
    });

  it("initializes a legacy profile from the normalized interface header", async () => {
      mockDbInstance.getUserProfile.mockResolvedValueOnce({ id: DEFAULT_USER, nickname: "墨白", avatar_url: null, locale: null });
      mockDbInstance.upsertUserProfile.mockResolvedValueOnce({ id: DEFAULT_USER, nickname: "墨白", avatar_url: null, locale: "en" });
      const profileRes = mockRes();
      await handleRequest(mockReq({ url: "/api/profile?user_id=forged", headers: {
        authorization: `Bearer ${authState.defaultToken}`, "x-interface-locale": "en",
      } }) as any, profileRes as any);
      expect(JSON.parse((profileRes.end as any).mock.calls[0][0])).toMatchObject({
        id: DEFAULT_USER, email: `${DEFAULT_USER}@example.com`, displayName: "墨白", locale: "en",
      });
      expect(mockDbInstance.upsertUserProfile).toHaveBeenCalledWith(expect.objectContaining({ locale: "en" }));
    });

  it("keeps a saved profile locale when the interface header disagrees", async () => {
      const profileRes = mockRes();
      await handleRequest(mockReq({ url: "/api/profile", headers: {
        authorization: `Bearer ${authState.defaultToken}`, "x-interface-locale": "en",
      } }) as any, profileRes as any);

      expect(JSON.parse((profileRes.end as any).mock.calls[0][0])).toMatchObject({ locale: "zh-CN" });
      expect(mockDbInstance.upsertUserProfile).not.toHaveBeenCalled();
    });

  it("returns a stable invalid-locale error code from profile updates", async () => {
      const req = mockReq({ method: "PATCH", url: "/api/profile" });
      mockBody(req, { locale: "fr" });
      const res = mockRes();

      await handleRequest(req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(JSON.parse((res.end as any).mock.calls[0][0])).toEqual({
        error: {
          code: "INVALID_PROFILE_LOCALE",
          message: "Unsupported interface locale",
        },
      });
    });

  it("preserves binary avatar bytes", async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      mockDbInstance.upsertUserProfile.mockResolvedValue({ id: DEFAULT_USER, nickname: "墨白", avatar_url: "https://files.test/avatar", locale: "zh-CN" });
      const req = mockReq({ method: "POST", url: "/api/profile/avatar", headers: {
        authorization: `Bearer ${authState.defaultToken}`, "content-type": "image/png",
      } });
      mockRawBody(req, png);
      const res = mockRes();
      await handleRequest(req as any, res as any);
      expect(mockStorageInstance.writeBytes).toHaveBeenCalledWith(expect.any(String), png, "image/png");
    });
});
