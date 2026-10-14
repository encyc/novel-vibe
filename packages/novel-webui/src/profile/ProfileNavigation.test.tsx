import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalModeProvider } from "../local-mode";
import type { User, UserProfile } from "../types";
import { ProfileNavigation } from "./ProfileNavigation";

const user: User = { id: "user-1", email: "writer@example.com" };
const profile: UserProfile = {
  id: "user-1",
  email: "writer@example.com",
  displayName: "墨白",
  avatarUrl: null,
  locale: "zh-CN",
};

afterEach(cleanup);

describe("ProfileNavigation", () => {
  it("renders grouped desktop navigation with an accessible current item", async () => {
    const onChange = vi.fn();
    render(<ProfileNavigation current="balance" onChange={onChange} profile={profile} user={user} />);

    expect(screen.getByRole("navigation", { name: "个人中心导航" })).toBeInTheDocument();
    expect(screen.getByText("墨白")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "额度概览" })).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("button")).toHaveLength(10);

    await userEvent.click(screen.getByRole("button", { name: "邀请奖励" }));
    expect(onChange).toHaveBeenCalledWith("referral");
  });

  it("exposes all sections through the mobile selector", async () => {
    const onChange = vi.fn();
    render(<ProfileNavigation current="identity" onChange={onChange} profile={undefined} user={user} />);

    const selector = screen.getByRole("combobox", { name: "选择个人中心栏目" });
    expect(selector).toHaveValue("identity");
    expect(screen.getAllByRole("option")).toHaveLength(10);

    await userEvent.selectOptions(selector, "activity");
    expect(onChange).toHaveBeenCalledWith("activity");
  });

  it("drops hosted-only sections in local-first mode on desktop and mobile", () => {
    render(
      <LocalModeProvider value>
        <ProfileNavigation current="identity" onChange={vi.fn()} profile={profile} user={user} />
      </LocalModeProvider>,
    );

    // identity, preferences, BYOK settings and API tokens remain.
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.getAllByRole("option")).toHaveLength(4);
    for (const label of ["额度概览", "使用活动", "账目记录", "充值额度", "会员计划", "邀请奖励"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "个人资料" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "自带模型密钥" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "API Token" })).toBeInTheDocument();
  });

  it("annotates an eligible referral campaign on desktop and mobile", () => {
    render(
      <ProfileNavigation
        current="identity"
        onChange={vi.fn()}
        profile={profile}
        referralCampaign={{ kind: "eligible", rewardDays: 10 }}
        user={user}
      />,
    );

    expect(screen.getByText("双方 +10 天")).toBeInTheDocument();
    expect(screen.getByText("邀请活动：双方 +10 天")).toBeInTheDocument();
  });

  it("shows the membership prerequisite for an inactive inviter", () => {
    render(
      <ProfileNavigation
        current="identity"
        onChange={vi.fn()}
        profile={profile}
        referralCampaign={{ kind: "membership" }}
        user={user}
      />,
    );

    expect(screen.getByText("开通会员后可邀请")).toBeInTheDocument();
    expect(screen.getByText("邀请活动：开通会员后可邀请")).toBeInTheDocument();
  });

  it("omits campaign annotation when no active referral state is supplied", () => {
    render(<ProfileNavigation current="identity" onChange={vi.fn()} profile={profile} user={user} />);

    expect(screen.queryByText(/双方 \+\d+ 天|开通会员后可邀请/)).not.toBeInTheDocument();
  });
});
