import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export const resources = {
  "zh-CN": { translation: zhCN },
  en: { translation: en },
} as const;

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    supportedLngs: ["zh-CN", "en"],
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    initAsync: false,
  });

export { i18n };
