import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("verified registration", () => {
    it("posts hashed registration code material to the request RPC", async () => {
      ctx.mockOk({ accepted: true, retry_after_seconds: 60 });
      await ctx.db.requestRegistrationCode({
        email: "u@example.com", codeHash: "code-hash", ipHash: "ip-hash",
        subject: "subject", text: "text", html: "html",
      });
      const [url, init] = ctx.fetchMock.mock.calls[0];
      expect(String(url)).toContain("/rpc/request_registration_email_code");
      expect(JSON.parse(init.body)).toEqual({
        p_email: "u@example.com", p_code_hash: "code-hash", p_ip_hash: "ip-hash",
        p_subject: "subject", p_text_body: "text", p_html_body: "html",
        p_invite_code: null, p_device_hash: null,
      });
    });

    it("uses the authenticated identity fields when finalizing", async () => {
      ctx.mockOkRaw(true);
      await expect(ctx.db.finalizeRegistrationReservation({
        reservationHash: "reservation-hash", userId: "00000000-0000-4000-8000-000000000001",
        email: "u@example.com",
      })).resolves.toBe(true);
      expect(JSON.parse(ctx.fetchMock.mock.calls[0][1].body)).toEqual({
        p_reservation_hash: "reservation-hash",
        p_user_id: "00000000-0000-4000-8000-000000000001",
        p_email: "u@example.com",
      });
    });
  });
