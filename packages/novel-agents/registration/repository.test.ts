import { describe, expect, it, vi } from "vitest";
import { RegistrationRepository } from "./repository.js";

describe("RegistrationRepository", () => {
  it("delegates the typed registration lifecycle", async () => {
    const db = {
      requestRegistrationCode: vi.fn().mockResolvedValue({ accepted: true, retry_after_seconds: 60 }),
      verifyRegistrationCode: vi.fn(), reserveRegistrationTicket: vi.fn(),
      releaseRegistrationReservation: vi.fn(), finalizeRegistrationReservation: vi.fn(),
    };
    const repo = new RegistrationRepository(db as never);
    await repo.requestRegistrationCode({ email: "u@example.com", codeHash: "c", ipHash: "i", subject: "s", text: "t", html: "h" });
    expect(db.requestRegistrationCode).toHaveBeenCalledWith(expect.objectContaining({ email: "u@example.com" }));
  });
});
