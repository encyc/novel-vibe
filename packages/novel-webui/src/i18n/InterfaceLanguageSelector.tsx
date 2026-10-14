import { Check, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useInterfaceLocale } from "./LocaleProvider";
import type { InterfaceLocale } from "./locale";

const options: { code: string; labelKey: "common.chinese" | "common.english"; locale: InterfaceLocale }[] = [
  { code: "ZH", labelKey: "common.chinese", locale: "zh-CN" },
  { code: "EN", labelKey: "common.english", locale: "en" },
];

export function InterfaceLanguageSelector({ authenticated }: { authenticated: boolean }) {
  const { t } = useTranslation();
  const { locale, setAnonymousLocale, updateAccountLocale } = useInterfaceLocale();

  function select(next: InterfaceLocale) {
    if (next === locale) return;
    const action = authenticated ? updateAccountLocale(next) : setAnonymousLocale(next);
    void action.catch(() => undefined);
  }

  return (
    <fieldset className="interface-language-selector">
      <legend className="interface-language-label">
        <Languages aria-hidden="true" size={14} />
        <span>{t("common.interfaceLanguage")}</span>
      </legend>
      <div className="interface-language-options">
        {options.map((option) => {
          const active = locale === option.locale;
          return (
            <button
              aria-label={t(option.labelKey)}
              aria-pressed={active}
              className="interface-language-option"
              key={option.locale}
              onClick={() => select(option.locale)}
              type="button"
            >
              <span className="interface-language-copy">
                <strong>{t(option.labelKey)}</strong>
                <small aria-hidden="true">{option.code}</small>
              </span>
              <Check aria-hidden="true" className="interface-language-check" size={13} strokeWidth={2.4} />
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
