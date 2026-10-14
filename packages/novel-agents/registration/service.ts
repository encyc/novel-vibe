import {
  generateEmailCode, generateOpaqueToken, isRegistrationEmail,
  normalizeRegistrationEmail, registrationSecret, secretHash,
} from "./crypto.js";
import { RegistrationError, type RegistrationDataSource, type RegistrationLocale } from "./types.js";

function normalizeInviteCode(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}

function codeEmail(code: string, locale: RegistrationLocale) {
  if (locale === "en") return {
    subject: "[Novel Vibe] Your registration code",
    text: `Your Novel Vibe registration code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your Novel Vibe registration code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
  };
  return {
    subject: "[Novel Vibe] 注册验证码",
    text: `你的 Novel Vibe 注册验证码是 ${code}，10 分钟内有效。`,
    html: `<p>你的 Novel Vibe 注册验证码是 <strong>${code}</strong>。</p><p>10 分钟内有效。</p>`,
  };
}

function invalidEmail(): never {
  throw new RegistrationError("INVALID_EMAIL", 400, "Invalid email address");
}

export class RegistrationService {
  private readonly secret: string;
  constructor(private readonly repo: RegistrationDataSource, secret = registrationSecret()) {
    this.secret = secret;
  }

  async sendCode(input: {
    email: string; ip: string; locale: RegistrationLocale; inviteCode?: string; deviceId?: string;
  }) {
    const email = normalizeRegistrationEmail(input.email);
    if (!isRegistrationEmail(email)) invalidEmail();
    const code = generateEmailCode();
    const message = codeEmail(code, input.locale);
    try {
      await this.repo.requestRegistrationCode({
        email,
        codeHash: secretHash(this.secret, "registration-code", `${email}\0${code}`),
        ipHash: secretHash(this.secret, "registration-ip", input.ip),
        inviteCode: normalizeInviteCode(input.inviteCode),
        deviceHash: input.deviceId
          ? secretHash(this.secret, "registration-device", input.deviceId)
          : undefined,
        ...message,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (messageText.includes("cooldown") || messageText.includes("rate_limited")) {
        throw new RegistrationError("CODE_RATE_LIMITED", 429, "Registration code rate limited");
      }
      throw error;
    }
    return { accepted: true as const, retryAfterSeconds: 60 as const };
  }

  async verifyCode(input: { email: string; code: string; inviteCode?: string }) {
    const email = normalizeRegistrationEmail(input.email);
    if (!isRegistrationEmail(email) || !/^\d{6}$/.test(input.code)) {
      throw new RegistrationError("CODE_INVALID", 400, "Invalid registration code");
    }
    const ticket = generateOpaqueToken();
    const row = await this.repo.verifyRegistrationCode({
      email,
      codeHash: secretHash(this.secret, "registration-code", `${email}\0${input.code}`),
      ticketHash: secretHash(this.secret, "registration-ticket", ticket),
      inviteCode: normalizeInviteCode(input.inviteCode),
    });
    if (row?.status !== "verified") {
      const code = row?.status === "expired" ? "CODE_EXPIRED"
        : row?.status === "attempts_exhausted" ? "CODE_ATTEMPTS_EXHAUSTED" : "CODE_INVALID";
      throw new RegistrationError(code, 400, "Registration code rejected");
    }
    return { ticket, expiresInSeconds: 900 as const };
  }

  async reserve(input: { email: string; ticket: string; inviteCode?: string }) {
    const normalizedEmail = normalizeRegistrationEmail(input.email);
    if (!isRegistrationEmail(normalizedEmail) || !input.ticket) {
      throw new RegistrationError("TICKET_INVALID", 400, "Registration ticket invalid");
    }
    const reservation = generateOpaqueToken();
    try {
      await this.repo.reserveRegistrationTicket({
        email: normalizedEmail,
        ticketHash: secretHash(this.secret, "registration-ticket", input.ticket),
        reservationHash: secretHash(this.secret, "registration-reservation", reservation),
        inviteCode: normalizeInviteCode(input.inviteCode),
      });
    } catch {
      throw new RegistrationError("TICKET_INVALID", 400, "Registration ticket invalid");
    }
    return { reservation, normalizedEmail };
  }

  async release(reservation: string): Promise<void> {
    await this.repo.releaseRegistrationReservation(secretHash(this.secret, "registration-reservation", reservation));
  }

  async finalize(input: { reservation: string; userId: string; email: string }) {
    const email = normalizeRegistrationEmail(input.email);
    try {
      const ok = await this.repo.finalizeRegistrationReservation({
        reservationHash: secretHash(this.secret, "registration-reservation", input.reservation),
        userId: input.userId,
        email,
      });
      if (!ok) throw new Error("identity mismatch");
    } catch {
      throw new RegistrationError("REGISTRATION_IDENTITY_MISMATCH", 403, "Registration identity mismatch");
    }
    return { ok: true as const };
  }
}
