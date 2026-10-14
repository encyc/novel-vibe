import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { api } from "../api/client";
import { i18n } from "./config";
import {
  detectBrowserLocale,
  type InterfaceLocale,
  readStoredLocale,
  storeLocale,
} from "./locale";

interface LocaleContextValue {
  locale: InterfaceLocale;
  setAnonymousLocale(locale: InterfaceLocale): Promise<void>;
  adoptProfileLocale(locale: InterfaceLocale): Promise<void>;
  updateAccountLocale(locale: InterfaceLocale): Promise<void>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: PropsWithChildren) {
  const [locale, setLocale] = useState<InterfaceLocale>(
    () => readStoredLocale() ?? detectBrowserLocale(),
  );

  const apply = useCallback(async (next: InterfaceLocale) => {
    const languageChange = i18n.resolvedLanguage === next
      ? Promise.resolve()
      : i18n.changeLanguage(next);
    const translate = i18n.getFixedT(next);
    document.documentElement.lang = next;
    document.title = translate("metadata.title");
    document.querySelector('meta[name="description"]')
      ?.setAttribute("content", translate("metadata.description"));
    storeLocale(next);
    setLocale(next);
    await languageChange;
  }, []);

  useLayoutEffect(() => {
    void apply(locale);
  }, [apply, locale]);

  const setAnonymousLocale = useCallback(
    async (next: InterfaceLocale) => apply(next),
    [apply],
  );

  const adoptProfileLocale = useCallback(
    async (next: InterfaceLocale) => apply(next),
    [apply],
  );

  const updateAccountLocale = useCallback(async (next: InterfaceLocale) => {
    if (next === locale) return;
    const previous = locale;
    await apply(next);
    try {
      const profile = await api.updateProfile({ locale: next });
      if (profile.locale !== next) await apply(profile.locale);
    } catch (error) {
      await apply(previous);
      throw error;
    }
  }, [apply, locale]);

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setAnonymousLocale,
    adoptProfileLocale,
    updateAccountLocale,
  }), [adoptProfileLocale, locale, setAnonymousLocale, updateAccountLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useInterfaceLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useInterfaceLocale must be used within LocaleProvider");
  return value;
}
