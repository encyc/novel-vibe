export type RegistrationLocale = "zh-CN" | "en";

export type RegistrationErrorCode =
  | "INVALID_EMAIL"
  | "CODE_RATE_LIMITED"
  | "CODE_INVALID"
  | "CODE_EXPIRED"
  | "CODE_ATTEMPTS_EXHAUSTED"
  | "TICKET_INVALID"
  | "TICKET_EXPIRED"
  | "REGISTRATION_IDENTITY_MISMATCH";

export class RegistrationError extends Error {
  constructor(readonly code: RegistrationErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "RegistrationError";
  }
}

export interface RegistrationDataSource {
  requestRegistrationCode(input: {
    email: string; codeHash: string; ipHash: string; subject: string; text: string; html: string;
    inviteCode?: string; deviceHash?: string;
  }): Promise<{ accepted: boolean; retry_after_seconds: number } | null>;
  verifyRegistrationCode(input: {
    email: string; codeHash: string; ticketHash: string; inviteCode?: string;
  }): Promise<{ status: string; ticket_id: string | null; expires_at: string | null } | null>;
  reserveRegistrationTicket(input: {
    email: string; ticketHash: string; reservationHash: string; inviteCode?: string;
  }): Promise<{ reservation_id: string; expires_at: string } | null>;
  releaseRegistrationReservation(reservationHash: string): Promise<boolean>;
  finalizeRegistrationReservation(input: {
    reservationHash: string; userId: string; email: string;
  }): Promise<boolean>;
}
