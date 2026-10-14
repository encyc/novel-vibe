import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import type { MembershipEntitlement } from "../types";
import { MembershipPage } from "./MembershipPage";

vi.mock("../api/client", () => ({
  api: {
    getMembershipPlans: vi.fn(),
    getMembershipStatus: vi.fn(),
    getMembershipEntitlements: vi.fn().mockResolvedValue({ catalog: [], premiumModels: [] }),
    createMembershipPurchase: vi.fn(),
    logout: vi.fn(),
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

const PLAN = {
  id: "p1", slug: "monthly", name: "月卡会员", priceCents: 990,
  durationDays: 30, bonusCredits: 100,
  features: ["unlimited_projects", "export", "web_search"],
};

const CATALOG: MembershipEntitlement[] = [
  { key: "unlimited_projects", category: "workspace", sortOrder: 10 },
  { key: "export", category: "creation", sortOrder: 20 },
  { key: "web_search", category: "creation", sortOrder: 30 },
];

describe("MembershipPage", () => {
  beforeEach(() => {
    vi.mocked(api.getMembershipPlans).mockResolvedValue([PLAN]);
    vi.mocked(api.getMembershipEntitlements).mockResolvedValue({ catalog: CATALOG, premiumModels: [] });
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("zh-CN");
  });

  it("renders the catalog-driven comparison table grouped by category", async () => {
    vi.mocked(api.getMembershipStatus).mockResolvedValue({ active: false, planName: null, expiresAt: null, features: [] });
    render(withClient(<MembershipPage />));

    expect(await screen.findByRole("heading", { name: "会员权益" })).toBeInTheDocument();
    expect(screen.getByText("创作空间")).toBeInTheDocument();
    expect(screen.getByText("创作功能")).toBeInTheDocument();
    // Empty categories must not render.
    expect(screen.queryByText("社区身份")).not.toBeInTheDocument();
    expect(screen.getByText("最多 3 个")).toBeInTheDocument();
    expect(screen.getByText("数量不限")).toBeInTheDocument();
    expect(screen.getByText("导出 md / txt / docx 全文")).toBeInTheDocument();
  });

  it("shows the active membership state and triggers purchase", async () => {
    vi.mocked(api.getMembershipStatus).mockResolvedValue({
      active: true, planName: "月卡会员", expiresAt: "2026-09-05T00:00:00.000Z", features: PLAN.features,
    });
    vi.mocked(api.createMembershipPurchase).mockResolvedValue({ orderNo: "MC-1", payUrl: "https://zpayz.cn/x" });
    const originalAssign = window.location.assign;
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...window.location, assign } });

    render(withClient(<MembershipPage />));
    expect(await screen.findByText(/会员生效中/)).toBeInTheDocument();
    const button = await screen.findByRole("button", { name: /续费月卡/ });
    await userEvent.click(button);
    expect(api.createMembershipPurchase).toHaveBeenCalledWith("p1");

    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...originalAssign } });
  });
});
