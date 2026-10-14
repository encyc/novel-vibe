import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import { SettingsPage } from "./SettingsPage";

vi.mock("../api/client", () => ({
  api: {
    getMembershipStatus: vi.fn(),
    getByokConfig: vi.fn(),
    listLlmKeys: vi.fn(),
    saveLlmKey: vi.fn(),
    deleteLlmKey: vi.fn(),
  },
}));

function withClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

const MEMBER = { active: true, planName: "月卡会员", expiresAt: "2026-10-01T00:00:00.000Z", features: ["byok"] };
const NON_MEMBER = { active: false, planName: null, expiresAt: null, features: [] };
const CONFIG = {
  enabled: true,
  providers: [
    { id: "deepseek", label: "DeepSeek", models: [{ id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000 }] },
  ],
};

describe("SettingsPage BYOK", () => {
  beforeEach(() => {
    vi.mocked(api.getByokConfig).mockResolvedValue(CONFIG);
    vi.mocked(api.listLlmKeys).mockResolvedValue({ keys: [] });
    vi.mocked(api.saveLlmKey).mockResolvedValue({
      key: { provider: "deepseek", keyLast4: "3456", updatedAt: "2026-09-03T00:00:00Z" },
    });
    vi.mocked(api.deleteLlmKey).mockResolvedValue({ revoked: true });
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("zh-CN");
  });

  it("shows the upgrade CTA for non-members without any key form", async () => {
    vi.mocked(api.getMembershipStatus).mockResolvedValue(NON_MEMBER);
    render(withClient(<SettingsPage />));
    expect(await screen.findByText(/月卡会员专属/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /开通月卡/ })).toHaveAttribute("href", "/profile/membership");
    expect(screen.queryByPlaceholderText("sk-...")).not.toBeInTheDocument();
  });

  it("lists a saved key masked and allows deletion", async () => {
    vi.mocked(api.getMembershipStatus).mockResolvedValue(MEMBER);
    vi.mocked(api.listLlmKeys).mockResolvedValue({
      keys: [{ provider: "deepseek", keyLast4: "abcd", updatedAt: "2026-09-03T00:00:00Z" }],
    });
    render(withClient(<SettingsPage />));
    expect(await screen.findByText("已保存（末四位 abcd）")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sk-...")).not.toBeInTheDocument();
    // The dropdown option also reflects the saved state.
    expect(screen.getByRole("combobox", { name: "选择模型平台" })).toHaveValue("deepseek");
    await userEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(api.deleteLlmKey).toHaveBeenCalledWith("deepseek");
  });

  it("saves a new key via the form", async () => {
    vi.mocked(api.getMembershipStatus).mockResolvedValue(MEMBER);
    render(withClient(<SettingsPage />));
    const input = await screen.findByPlaceholderText("sk-...");
    await userEvent.type(input, "sk-live-abcdefgh");
    await userEvent.click(screen.getByRole("button", { name: /保存密钥/ }));
    expect(api.saveLlmKey).toHaveBeenCalledWith("deepseek", "sk-live-abcdefgh");
  });

  it("shows the unavailable notice when byok is disabled server-side", async () => {
    vi.mocked(api.getMembershipStatus).mockResolvedValue(MEMBER);
    vi.mocked(api.getByokConfig).mockResolvedValue({ enabled: false, providers: [] });
    render(withClient(<SettingsPage />));
    expect(await screen.findByText(/暂未开放/)).toBeInTheDocument();
  });
});
