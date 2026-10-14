import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { localizeApiError } from "../i18n/error-message";
import { InterfaceLanguageSelector } from "../i18n/InterfaceLanguageSelector";
import type { User } from "../types";
import { LoginBloom } from "./LoginBloom";

interface LoginViewProps {
  initialError: string | null;
  onAuthenticated: (user: User) => void;
}

export function LoginView({ initialError, onAuthenticated }: LoginViewProps) {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">(params.get("mode") === "signup" ? "signup" : "login");
  const [signupStep, setSignupStep] = useState<"details" | "code" | "verified">("details");
  const [code, setCode] = useState("");
  const [registrationTicket, setRegistrationTicket] = useState("");
  const [inviteCode, setInviteCode] = useState(params.get("invite")?.trim().toUpperCase() ?? "");
  const [resendSeconds, setResendSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const normalizedInviteCode = inviteCode.trim().toUpperCase();
  const invitation = useQuery({
    enabled: mode === "signup" && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalizedInviteCode),
    queryKey: ["referrals", "preview", normalizedInviteCode],
    queryFn: () => api.getReferralPreview(normalizedInviteCode),
    retry: false,
  });

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setInterval(() => setResendSeconds((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [resendSeconds > 0]);

  function chooseMode(next: "login" | "signup") {
    setMode(next);
    setSignupStep("details");
    setCode("");
    setRegistrationTicket("");
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const normalizedEmail = email.trim();
      if (mode === "signup" && signupStep === "details") {
        if (normalizedInviteCode && (!invitation.data?.valid || invitation.isLoading)) {
          setError(t("auth.inviteUnavailable"));
          return;
        }
        const result = await api.sendRegistrationCode(normalizedEmail, inviteCode || undefined);
        setResendSeconds(result.retryAfterSeconds);
        setSignupStep("code");
        return;
      }
      if (mode === "signup" && signupStep === "code") {
        const result = await api.verifyRegistrationCode(normalizedEmail, code.trim(), inviteCode || undefined);
        setRegistrationTicket(result.ticket);
        setSignupStep("verified");
        return;
      }
      if (mode === "signup") await api.signup(normalizedEmail, password, registrationTicket, inviteCode || undefined);
      else await api.login(normalizedEmail, password, "login");
      const user = await api.me();
      if (!user) throw new Error(t("auth.signedInUserMissing"));
      onAuthenticated(user);
    } catch (err) {
      setError(localizeApiError(err, "auth.authenticationFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (resendSeconds > 0 || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.sendRegistrationCode(email.trim(), inviteCode || undefined);
      setResendSeconds(result.retryAfterSeconds);
      setCode("");
    } catch (err) {
      setError(localizeApiError(err, "auth.authenticationFailed"));
    } finally { setBusy(false); }
  }

  return (
    <main className="login-screen">
      <div className="login-edition">
        <section aria-label={t("auth.foreword")} className="login-foreword">
          <LoginBloom />
          <span className="login-chapter">LINGQI · ENTRY LEAF · 01</span>
          <div className="brand-lockup">
            <span className="brand-icon"><img alt="" src="/brand/logo-icon.svg" /></span>
            <div>
              <h1>{t("common.brand")}</h1>
              <p>{t("auth.productTagline")}</p>
            </div>
          </div>
          <div className="login-foreword-copy">
            <h2>{t("auth.storyGrows")}</h2>
            <p>{t("auth.collaboration")}</p>
          </div>
          <p className="login-foreword-note">{t("auth.processNote")}</p>
          <span aria-hidden="true" className="login-vertical-mark">
            {t("auth.verticalMark").split("\n").map((line, index) => (
              <Fragment key={line}>{index ? <br /> : null}{line}</Fragment>
            ))}
          </span>
        </section>

        <section aria-label={t("auth.accountLogin")} className="login-panel">
          <div className="login-panel-heading">
            <span>{t("auth.writerAccess")}</span>
            <h2>{t(mode === "login" ? "auth.signInHeading" : "auth.signUpHeading")}</h2>
            <p>{t(mode === "login" ? "auth.signInDescription" : "auth.signUpDescription")}</p>
          </div>
          <InterfaceLanguageSelector authenticated={false} />
          <form className="login-form" onSubmit={submit}>
            <label>{t("auth.email")}<input autoComplete="email" disabled={mode === "signup" && signupStep !== "details"} inputMode="email" required value={email} onChange={(event) => { setEmail(event.target.value); setRegistrationTicket(""); }} /></label>
            {mode === "signup" && <label>{t("auth.inviteCode")}<input autoComplete="off" disabled={signupStep !== "details"} maxLength={32} value={inviteCode} onChange={(event) => { setInviteCode(event.target.value.toUpperCase()); setRegistrationTicket(""); }} /></label>}
            {mode === "signup" && normalizedInviteCode ? <div className="login-invitation" aria-live="polite">
              {invitation.isLoading ? <p>{t("auth.inviteChecking")}</p> : invitation.data?.valid ? (
                <p>{t("auth.invitePromise", { days: invitation.data.rewardDays, window: invitation.data.purchaseWindowDays })}</p>
              ) : <p>{t(`auth.inviteReasons.${invitation.data?.unavailableReason ?? "invalid_code"}`)} <button className="text-button" onClick={() => setInviteCode("")} type="button">{t("auth.removeInvite")}</button></p>}
            </div> : null}
            {mode === "signup" && signupStep === "code" && <>
              <label>{t("auth.verificationCode")}<input autoComplete="one-time-code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
              <button className="text-button" disabled={busy || resendSeconds > 0} onClick={() => void resendCode()} type="button">{resendSeconds > 0 ? t("auth.resendCountdown", { seconds: resendSeconds }) : t("auth.resendCode")}</button>
            </>}
            {(mode === "login" || signupStep === "verified") && <label>{t("auth.password")}<input autoComplete={mode === "login" ? "current-password" : "new-password"} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}

            <div className="segmented" role="group" aria-label={t("auth.mode")}>
              <button type="button" className={mode === "login" ? "active" : ""} onClick={() => chooseMode("login")}>{t("auth.signIn")}</button>
              <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => chooseMode("signup")}>{t("auth.signUp")}</button>
            </div>

            {error && <p className="form-error">{error}</p>}

            <button className="primary-button" type="submit" disabled={busy}>{busy ? <Loader2 className="spin" size={18} /> : null}{t(mode === "login" ? "auth.enterWorkspace" : signupStep === "details" ? "auth.sendCode" : signupStep === "code" ? "auth.verifyCode" : "auth.createAccount")}</button>
          </form>
          <footer><span>{t("auth.writerSystem")}</span><span>{t("auth.secureAccess")}</span></footer>
        </section>
      </div>
    </main>
  );
}
