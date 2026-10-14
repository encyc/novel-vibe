import { normalizeSupportedLanguage } from "../../lib/language.js";
import { RegistrationError } from "../../registration/types.js";
import { errorResponse, jsonResponse, parseBytes } from "../http.js";
import { createRegistrationService } from "../runtime.js";
import type { PublicRouteContext, RouteContext } from "../http.js";

function registrationErrorResponse(res: PublicRouteContext["res"], error: unknown): void {
  if (error instanceof RegistrationError) {
    errorResponse(res, error.status, error.code, error.message);
    return;
  }
  errorResponse(res, 500, "INTERNAL_ERROR");
}

async function registrationBody(req: PublicRouteContext["req"]): Promise<Record<string, unknown>> {
  return JSON.parse((await parseBytes(req, 16 * 1024)).toString("utf8"));
}

export async function registrationCodePost({ req, res }: PublicRouteContext) {
  try {
    const body = await registrationBody(req);
    const forwardedIp = req.headers["x-registration-client-ip"];
    const ip = typeof forwardedIp === "string" ? forwardedIp : req.socket?.remoteAddress ?? "unknown";
    jsonResponse(res, await createRegistrationService().sendCode({
      email: String(body.email ?? ""),
      ip,
      locale: normalizeSupportedLanguage(req.headers["x-interface-locale"], "zh-CN"),
      inviteCode: typeof body.inviteCode === "string" ? body.inviteCode : undefined,
      deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
    }));
  } catch (error) {
    registrationErrorResponse(res, error);
  }
}

export async function registrationVerifyPost({ req, res }: PublicRouteContext) {
  try {
    const body = await registrationBody(req);
    jsonResponse(res, await createRegistrationService().verifyCode({
      email: String(body.email ?? ""),
      code: String(body.code ?? ""),
      inviteCode: typeof body.inviteCode === "string" ? body.inviteCode : undefined,
    }));
  } catch (error) {
    registrationErrorResponse(res, error);
  }
}

export async function registrationReservePost({ req, res }: PublicRouteContext) {
  try {
    const body = await registrationBody(req);
    jsonResponse(res, await createRegistrationService().reserve({
      email: String(body.email ?? ""),
      ticket: String(body.ticket ?? ""),
      inviteCode: typeof body.inviteCode === "string" ? body.inviteCode : undefined,
    }));
  } catch (error) {
    registrationErrorResponse(res, error);
  }
}

export async function registrationReleasePost({ req, res }: PublicRouteContext) {
  try {
    const body = await registrationBody(req);
    await createRegistrationService().release(String(body.reservation ?? ""));
    jsonResponse(res, { ok: true });
  } catch (error) {
    registrationErrorResponse(res, error);
  }
}

export async function registrationFinalizePost({ req, res, userId, email }: RouteContext) {
  const body = await registrationBody(req);
  jsonResponse(res, await createRegistrationService().finalize({
    reservation: String(body.reservation ?? ""),
    userId,
    email,
  }));
}
