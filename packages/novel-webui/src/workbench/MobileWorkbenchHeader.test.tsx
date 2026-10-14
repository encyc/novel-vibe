import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileWorkbenchHeader } from "./MobileWorkbenchHeader";

afterEach(cleanup);

describe("MobileWorkbenchHeader", () => {
  it("exposes navigation and workspace-detail controls beside the chat-first base", async () => {
    const user = userEvent.setup();
    const onDetailOpenChange = vi.fn();
    const onContextOpenChange = vi.fn();
    render(
      <Tooltip.Provider>
        <MobileWorkbenchHeader
          contextOpen={false}
          detailOpen={false}
          moduleLabel="章节正文"
          onContextOpenChange={onContextOpenChange}
          onDetailOpenChange={onDetailOpenChange}
          projectTitle="长夜临渊"
        />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("banner", { name: "移动创作工作台" })).toBeInTheDocument();
    expect(screen.getByText("章节正文")).toBeInTheDocument();
    expect(screen.getByText("长夜临渊")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开导航" }));
    expect(onContextOpenChange).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: "展开创作区" }));
    expect(onDetailOpenChange).toHaveBeenCalledWith(true);
  });

  it("restores focus to the workspace trigger after the detail surface closes", () => {
    const props = {
      contextOpen: false,
      moduleLabel: "章节正文",
      onContextOpenChange: vi.fn(),
      onDetailOpenChange: vi.fn(),
      projectTitle: "长夜临渊",
    };
    const { rerender } = render(
      <Tooltip.Provider>
        <MobileWorkbenchHeader {...props} detailOpen />
      </Tooltip.Provider>,
    );

    rerender(
      <Tooltip.Provider>
        <MobileWorkbenchHeader {...props} detailOpen={false} />
      </Tooltip.Provider>,
    );

    expect(screen.getByRole("button", { name: "展开创作区" })).toHaveFocus();
  });
});
