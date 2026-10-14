import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegistrationError } from "./types.js";
import { RegistrationService } from "./service.js";

describe("RegistrationService", () => {
  const repo = {
    requestRegistrationCode: vi.fn(), verifyRegistrationCode: vi.fn(), reserveRegistrationTicket: vi.fn(),
    releaseRegistrationReservation: vi.fn(), finalizeRegistrationReservation: vi.fn(),
  };
  const service = new RegistrationService(repo, "test-secret");
  beforeEach(() => vi.clearAllMocks());

  it("normalizes send requests and returns a generic response", async () => {
    repo.requestRegistrationCode.mockResolvedValue({ accepted: true, retry_after_seconds: 60 });
    await expect(service.sendCode({
      email: " User@Example.com ", ip: "127.0.0.1", locale: "zh-CN",
      inviteCode: " abcd2345 ", deviceId: "browser-device",
    }))
      .resolves.toEqual({ accepted: true, retryAfterSeconds: 60 });
    expect(repo.requestRegistrationCode).toHaveBeenCalledWith(expect.objectContaining({
      email: "user@example.com", subject: "[Novel Vibe] 注册验证码", inviteCode: "ABCD2345",
      deviceHash: expect.any(String),
    }));
    const rawCode = repo.requestRegistrationCode.mock.calls[0][0].text.match(/\d{6}/)?.[0];
    expect(rawCode).toMatch(/^\d{6}$/);
    expect(repo.requestRegistrationCode.mock.calls[0][0].codeHash).not.toContain(rawCode);
  });

  it.each([
    ["invalid", "CODE_INVALID"], ["expired", "CODE_EXPIRED"], ["attempts_exhausted", "CODE_ATTEMPTS_EXHAUSTED"],
  ])("maps %s verification status", async (status, code) => {
    repo.verifyRegistrationCode.mockResolvedValue({ status, ticket_id: null, expires_at: null });
    await expect(service.verifyCode({ email: "u@example.com", code: "123456", inviteCode: " abcd2345 " }))
      .rejects.toMatchObject({ code });
    expect(repo.verifyRegistrationCode).toHaveBeenCalledWith(expect.objectContaining({ inviteCode: "ABCD2345" }));
  });

  it("reserves, releases, and finalizes opaque tickets", async () => {
    repo.reserveRegistrationTicket.mockResolvedValue({ reservation_id: "id", expires_at: new Date().toISOString() });
    repo.releaseRegistrationReservation.mockResolvedValue(true);
    repo.finalizeRegistrationReservation.mockResolvedValue(true);
    const reserved = await service.reserve({ email: "U@example.com", ticket: "ticket", inviteCode: "abc" });
    expect(reserved.reservation).not.toBe("ticket");
    await service.release(reserved.reservation);
    await expect(service.finalize({ reservation: reserved.reservation, userId: "u1", email: "u@example.com" }))
      .resolves.toEqual({ ok: true });
  });

  it("rejects an identity mismatch", async () => {
    repo.finalizeRegistrationReservation.mockRejectedValue(new Error("registration_identity_mismatch"));
    await expect(service.finalize({ reservation: "r", userId: "u1", email: "u@example.com" }))
      .rejects.toBeInstanceOf(RegistrationError);
  });
});
