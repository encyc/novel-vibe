import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ApiTokenSummary } from "../api/client";
import { i18n } from "../i18n/config";
import { ApiTokenCard } from "./ApiTokenCard";

vi.mock("../api/client", () => ({
  api: {
    listApiTokens: vi.fn(),
    createApiToken: vi.fn(),
    revokeApiToken: vi.fn(),
  },
}));

const TOKEN: ApiTokenSummary = {
  id: "token-1", public_id: "abcdefghijklmnop", user_id: "user-1", name: "桌面客户端",
  scopes: ["projects:read", "documents:read", "agents:run"],
  expires_at: "2026-10-06T00:00:00.000Z", last_used_at: null, revoked_at: null,
  created_at: "2026-07-08T00:00:00.000Z",
};

function renderCard(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  render(<QueryClientProvider client={client}><Tooltip.Provider><ApiTokenCard /></Tooltip.Provider></QueryClientProvider>);
  return client;
}

describe("ApiTokenCard", () => {
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("zh-CN");
  });
  beforeEach(() => {
    vi.mocked(api.listApiTokens).mockResolvedValue([]);
    vi.mocked(api.createApiToken).mockResolvedValue({ ...TOKEN, token: "lingqi_abcdefghijklmnop_once-only-secret" });
    vi.mocked(api.revokeApiToken).mockResolvedValue({ ok: true });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("offers name, lifetime, permission presets, and the agent permission warning", async () => {
    renderCard();
    expect(await screen.findByText("尚未创建 API Token。" )).toBeInTheDocument();
    expect(screen.getByLabelText("Token 名称")).toBeInTheDocument();
    expect(screen.getByLabelText("有效期")).toHaveValue("30");
    expect(within(screen.getByLabelText("有效期")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "30 天", "90 天", "365 天",
    ]);
    expect(screen.getByRole("checkbox", { name: /只读/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /写入/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /运行 Agent/ })).not.toBeChecked();
    expect(screen.getByText(/运行 Agent 可修改项目内容并消耗 Credit/)).toBeInTheDocument();
  });

  it("validates creation and submits the selected lifetime and presets", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("尚未创建 API Token。");
    await user.click(screen.getByRole("button", { name: "创建 Token" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请输入 Token 名称");
    await user.type(screen.getByLabelText("Token 名称"), "Claude Desktop");
    await user.selectOptions(screen.getByLabelText("有效期"), "90");
    await user.click(screen.getByRole("checkbox", { name: /运行 Agent/ }));
    await user.click(screen.getByRole("button", { name: "创建 Token" }));
    expect(api.createApiToken).toHaveBeenCalledWith({
      name: "Claude Desktop", lifetimeDays: 90, presets: ["read", "agent:run"],
    });
  });

  it("shows the plaintext once, copies it, and removes it from DOM and query cache after acknowledgement", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const client = renderCard();
    await screen.findByText("尚未创建 API Token。");
    await user.type(screen.getByLabelText("Token 名称"), "Claude Desktop");
    await user.click(screen.getByRole("button", { name: "创建 Token" }));
    const dialog = await screen.findByRole("dialog", { name: "保存 API Token" });
    const plaintext = "lingqi_abcdefghijklmnop_once-only-secret";
    expect(within(dialog).getByText(plaintext)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "复制 Token" }));
    expect(writeText).toHaveBeenCalledWith(plaintext);
    expect(JSON.stringify(client.getQueryData(["profile", "api-tokens"]))).not.toContain(plaintext);
    await user.click(within(dialog).getByRole("button", { name: "我已保存，关闭" }));
    await waitFor(() => expect(screen.queryByText(plaintext)).not.toBeInTheDocument());
  });

  it("lists safe details and revokes only after explicit confirmation", async () => {
    vi.mocked(api.listApiTokens).mockResolvedValue([TOKEN]);
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByText("桌面客户端")).toBeInTheDocument();
    expect(screen.getByText(/lingqi_abcdefghijklmnop/)).toBeInTheDocument();
    expect(screen.getAllByText(/只读/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Agent/).length).toBeGreaterThan(0);
    expect(screen.getByText(/从未使用/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "撤销桌面客户端" }));
    const dialog = screen.getByRole("dialog", { name: "撤销 API Token" });
    expect(api.revokeApiToken).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "确认撤销" }));
    expect(api.revokeApiToken).toHaveBeenCalledWith("token-1");
    await waitFor(() => expect(api.listApiTokens).toHaveBeenCalledTimes(2));
  });

  it("renders loading, error, and revoked states", async () => {
    let resolve!: (tokens: []) => void;
    vi.mocked(api.listApiTokens).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { unmount } = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ApiTokenCard /></QueryClientProvider>);
    expect(screen.getByText("正在读取 API Token…")).toBeInTheDocument();
    resolve([]);
    unmount();

    vi.mocked(api.listApiTokens).mockRejectedValueOnce(new Error("offline"));
    const errorClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={errorClient}><ApiTokenCard /></QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("API Token 加载失败");
  });

  it("localizes English chrome while preserving token names and public ids", async () => {
    await i18n.changeLanguage("en");
    vi.mocked(api.listApiTokens).mockResolvedValue([TOKEN]);
    renderCard();
    expect(await screen.findByText("桌面客户端")).toBeInTheDocument();
    expect(screen.getByText(/lingqi_abcdefghijklmnop/)).toBeInTheDocument();
    expect(screen.getByLabelText("Token name")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
  });
});
