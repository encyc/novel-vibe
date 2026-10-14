import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/config";
import type { SessionInteraction } from "../types";
import { InteractionCard } from "./InteractionCard";

afterEach(cleanup);

const interaction: SessionInteraction = {
  id: "interaction-1",
  assistantMessageId: "assistant-1",
  status: "pending",
  request: {
    schemaVersion: 1,
    id: "interaction-1",
    title: "选择下一幕基调",
    description: "这些选项会交回总编继续创作。",
    fields: [
      { id: "tone", type: "radio", label: "基调", required: true, options: [{ value: "warm", label: "克制温暖", description: "保留人物间的距离。" }, { value: "tense", label: "紧张" }] },
      { id: "motifs", type: "checkbox", label: "意象", required: false, maxSelections: 1, options: [{ value: "rain", label: "雨" }, { value: "letters", label: "旧信" }] },
    ],
    references: [],
    submitLabel: "继续创作",
    allowFreeAnswer: true,
  },
};

describe("InteractionCard", () => {
  it("renders semantic choices and an optional free answer below them", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<InteractionCard interaction={interaction} onSubmit={vi.fn()} />);
    expect(screen.getByRole("group", { name: /基调/ })).toBeVisible();
    expect(screen.getByRole("radio", { name: /克制温暖/ })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "补充回答（可选）" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "补充回答（可选）" }).compareDocumentPosition(screen.getByRole("button", { name: "继续创作" })))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps answers visible while reporting validation and network errors", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    render(<InteractionCard interaction={interaction} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "继续创作" }));
    expect(await screen.findByText("此项为必填")).toBeVisible();
    await user.click(screen.getByRole("radio", { name: /克制温暖/ }));
    await user.type(screen.getByRole("textbox", { name: "补充回答（可选）" }), "结尾留白");
    await user.click(screen.getByRole("button", { name: "继续创作" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("提交失败，请重试");
    expect(screen.getByRole("radio", { name: /克制温暖/ })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "补充回答（可选）" })).toHaveValue("结尾留白");
    await user.click(screen.getByRole("button", { name: "继续创作" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      interactionId: "interaction-1",
      answers: [{ fieldId: "tone", type: "radio", value: "warm" }],
      freeAnswer: "结尾留白",
    });
    expect(onSubmit.mock.calls[1][0].idempotencyKey).toBe(onSubmit.mock.calls[0][0].idempotencyKey);
  });

  it("renders a resolved interaction read-only", () => {
    render(<InteractionCard interaction={{
      ...interaction,
      status: "resolved",
      response: { schemaVersion: 1, interactionId: "interaction-1", idempotencyKey: "key-1", answers: [{ fieldId: "tone", type: "radio", value: "warm" }], freeAnswer: "结尾留白" },
    }} onSubmit={vi.fn()} />);
    expect(screen.getByText("已回答")).toBeVisible();
    expect(screen.queryByRole("button", { name: "继续创作" })).not.toBeInTheDocument();
    expect(screen.getByText("结尾留白")).toBeVisible();
  });
});
