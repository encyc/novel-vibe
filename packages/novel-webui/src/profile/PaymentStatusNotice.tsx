import { useTranslation } from "react-i18next";

export type PaymentConfirmation = { kind: "idle" } | { kind: "checking" | "completed" | "pending-timeout" | "failed"; orderNo: string; message?: string };
export function PaymentStatusNotice({ state }: { state: PaymentConfirmation }) {
  const { t } = useTranslation();
  if (state.kind === "idle") return null;
  const isMembership = state.orderNo.startsWith("MC-");
  const text = state.kind === "checking"
    ? t("profile.payment.checking")
    : state.kind === "completed"
      ? (isMembership ? t("profile.payment.membershipCompleted") : t("profile.payment.topupCompleted"))
      : state.kind === "pending-timeout"
        ? t("profile.payment.pending")
        : state.message || t("profile.payment.failed");
  return <div className="payment-status" data-kind={state.kind} role="status"><strong>{text}</strong><span>{t("profile.payment.order", { order: state.orderNo })}</span></div>;
}
