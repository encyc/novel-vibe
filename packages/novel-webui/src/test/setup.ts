import "@testing-library/jest-dom/vitest";
import { i18n } from "../i18n/config";
import { afterEach, beforeEach, vi } from "vitest";

const storageValues = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    clear: () => storageValues.clear(),
    getItem: (key: string) => storageValues.get(key) ?? null,
    removeItem: (key: string) => storageValues.delete(key),
    setItem: (key: string, value: string) => storageValues.set(key, value),
  },
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  window.localStorage.clear();
  window.localStorage.setItem("novel-vibe:interface-locale", "zh-CN");
  await i18n.changeLanguage("zh-CN");
});
