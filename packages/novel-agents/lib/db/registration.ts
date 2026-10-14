import type { DbRequestContext } from "./context.js";

async function registrationRpc(ctx: DbRequestContext, name: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${ctx.pgUrl}/rpc/${name}`, {
    method: "POST",
    headers: ctx.headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${name} failed [${res.status}]: ${await res.text()}`);
  const payload = await res.json();
  return Array.isArray(payload) ? payload[0] ?? null : payload;
}

export function requestRegistrationCode(ctx: DbRequestContext, input: {
  email: string; codeHash: string; ipHash: string; subject: string; text: string; html: string;
  inviteCode?: string; deviceHash?: string;
}) {
  return registrationRpc(ctx, "request_registration_email_code", {
    p_email: input.email,
    p_code_hash: input.codeHash,
    p_ip_hash: input.ipHash,
    p_subject: input.subject,
    p_text_body: input.text,
    p_html_body: input.html,
    p_invite_code: input.inviteCode ?? null,
    p_device_hash: input.deviceHash ?? null,
  });
}

export function verifyRegistrationCode(ctx: DbRequestContext, input: {
  email: string; codeHash: string; ticketHash: string; inviteCode?: string;
}) {
  return registrationRpc(ctx, "verify_registration_email_code", {
    p_email: input.email,
    p_code_hash: input.codeHash,
    p_ticket_hash: input.ticketHash,
    p_invite_code: input.inviteCode ?? null,
  });
}

export function reserveRegistrationTicket(ctx: DbRequestContext, input: {
  email: string; ticketHash: string; reservationHash: string; inviteCode?: string;
}) {
  return registrationRpc(ctx, "reserve_registration_ticket", {
    p_email: input.email,
    p_ticket_hash: input.ticketHash,
    p_reservation_hash: input.reservationHash,
    p_invite_code: input.inviteCode ?? null,
  });
}

export async function releaseRegistrationReservation(ctx: DbRequestContext, reservationHash: string): Promise<boolean> {
  return Boolean(await registrationRpc(ctx, "release_registration_reservation", {
    p_reservation_hash: reservationHash,
  }));
}

export async function finalizeRegistrationReservation(ctx: DbRequestContext, input: {
  reservationHash: string; userId: string; email: string;
}): Promise<boolean> {
  return Boolean(await registrationRpc(ctx, "finalize_registration_reservation", {
    p_reservation_hash: input.reservationHash,
    p_user_id: input.userId,
    p_email: input.email,
  }));
}
