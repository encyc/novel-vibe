import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { INTERFACE_LOCALE_COOKIE_NAME, type InterfaceLocale } from "./locale";
import { LocaleProvider, useInterfaceLocale } from "./LocaleProvider";

function Probe({ adopt }: { adopt?: InterfaceLocale }) {
  const { adoptProfileLocale, locale } = useInterfaceLocale();
  useEffect(() => {
    if (adopt) void adoptProfileLocale(adopt);
  }, [adopt, adoptProfileLocale]);
  return <span data-testid="locale">{locale}</span>;
}

function AccountProbe() {
  const { locale, updateAccountLocale } = useInterfaceLocale();
  return (
    <>
      <span data-testid="locale">{locale}</span>
      <button onClick={() => void updateAccountLocale("en").catch(() => undefined)} type="button">English</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  document.cookie = `${INTERFACE_LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0`;
  document.documentElement.lang = "";
  document.title = "";
});

describe("LocaleProvider", () => {
  it("uses stored locale before browser locale", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "en");
    vi.stubGlobal("navigator", { language: "zh-CN" });

    render(<LocaleProvider><Probe /></LocaleProvider>);

    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(document.title).toBe("Lingqi AI");
    expect(document.cookie).toContain(`${INTERFACE_LOCALE_COOKIE_NAME}=en`);
  });

  it("adopts the authoritative profile locale", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "zh-CN");

    render(<LocaleProvider><Probe adopt="en" /></LocaleProvider>);

    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(localStorage.getItem("novel-vibe:interface-locale")).toBe("en");
    expect(document.cookie).toContain(`${INTERFACE_LOCALE_COOKIE_NAME}=en`);
  });

  it("rolls back an optimistic account change when persistence fails", async () => {
    vi.spyOn(api, "updateProfile").mockRejectedValue(new Error("network"));
    localStorage.setItem("novel-vibe:interface-locale", "zh-CN");

    render(<LocaleProvider><AccountProbe /></LocaleProvider>);
    await act(async () => screen.getByRole("button", { name: "English" }).click());

    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN");
    expect(localStorage.getItem("novel-vibe:interface-locale")).toBe("zh-CN");
    expect(document.cookie).toContain(`${INTERFACE_LOCALE_COOKIE_NAME}=zh-CN`);
  });
});
