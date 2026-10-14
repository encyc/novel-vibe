import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { AppProviders } from "../app/AppProviders";
import { LoginView } from "./LoginView";

describe("LoginView verified signup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("prefills an invitation and verifies email before creating the account", async () => {
    window.history.replaceState({}, "", "/login?mode=signup&invite=abcd2345");
    vi.spyOn(api, "getReferralPreview").mockResolvedValue({
      valid: true, code: "ABCD2345", rewardDays: 10, purchaseWindowDays: 30,
      bindingEndsAt: "2026-09-30T00:00:00Z",
    });
    vi.spyOn(api, "sendRegistrationCode").mockResolvedValue({ accepted: true, retryAfterSeconds: 60 });
    vi.spyOn(api, "verifyRegistrationCode").mockResolvedValue({ ticket: "ticket", expiresInSeconds: 900 });
    vi.spyOn(api, "signup").mockResolvedValue();
    vi.spyOn(api, "me").mockResolvedValue({ id: "u1", email: "u@example.com" });
    const authenticated = vi.fn();
    const user = userEvent.setup();
    render(<AppProviders><LoginView initialError={null} onAuthenticated={authenticated} /></AppProviders>);

    expect(screen.getByDisplayValue("ABCD2345")).toBeInTheDocument();
    expect(await screen.findByText(/双方各得 10 天会员/)).toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("邮箱"), "u@example.com");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));
    await user.type(await screen.findByLabelText("邮箱验证码"), "123456");
    await user.click(screen.getByRole("button", { name: "验证邮箱" }));
    await user.type(await screen.findByLabelText("密码"), "secret");
    await user.click(screen.getByRole("button", { name: "创建账号" }));

    expect(api.signup).toHaveBeenCalledWith("u@example.com", "secret", "ticket", "ABCD2345");
    expect(authenticated).toHaveBeenCalledWith({ id: "u1", email: "u@example.com" });
  });
});
