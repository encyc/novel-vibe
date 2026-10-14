import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  detectBrowserLocale,
  normalizeInterfaceLocale,
  readStoredLocale,
  storeLocale,
} from "./locale";
import { resources } from "./config";
import { formatCredit, formatDate, formatNumber } from "./format";
import { LocaleProvider } from "./LocaleProvider";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("interface locale", () => {
  it("normalizes browser locales", () => {
    expect(normalizeInterfaceLocale("en-US")).toBe("en");
    expect(normalizeInterfaceLocale("zh-TW")).toBe("zh-CN");
    expect(normalizeInterfaceLocale("fr-FR")).toBe("zh-CN");
  });

  it("detects the browser locale", () => {
    vi.stubGlobal("navigator", { language: "en-GB" });

    expect(detectBrowserLocale()).toBe("en");
  });

  it("reads and stores only supported locales", () => {
    storeLocale("en");

    expect(readStoredLocale()).toBe("en");
    window.localStorage.setItem("novel-vibe:interface-locale", "fr-FR");
    expect(readStoredLocale()).toBeNull();
  });
});

describe("translation resources", () => {
  it("keeps Chinese and English key sets identical", () => {
    expect(flattenKeys(resources.en.translation).sort())
      .toEqual(flattenKeys(resources["zh-CN"].translation).sort());
  });

  it("updates document metadata from the active locale", async () => {
    window.localStorage.setItem("novel-vibe:interface-locale", "en");
    const description = document.createElement("meta");
    description.name = "description";
    document.head.append(description);

    render(createElement(LocaleProvider, null, createElement("div")));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en");
      expect(document.title).toBe("Lingqi AI");
      expect(description.content).toBe("Lingqi AI long-form writing workspace");
    });

    cleanup();
    description.remove();
  });
});

describe("locale-aware formatters", () => {
  it("formats dates, numbers, and credits with the supplied locale", () => {
    expect(formatDate("2026-07-28T00:00:00.000Z", "en", { timeZone: "UTC" }))
      .toBe("7/28/2026");
    expect(formatNumber(1234567.89, "en")).toBe("1,234,567.89");
    expect(formatCredit(12.345, "en")).toBe("12.35");
  });
});
