import { useTranslation } from "react-i18next";

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps) {
  const { t } = useTranslation();
  return (
    <span className="spinner" role="status">
      <span className="visually-hidden">{label ?? t("workbench.loading")}</span>
    </span>
  );
}
