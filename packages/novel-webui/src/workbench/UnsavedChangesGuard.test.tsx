import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesProvider, useUnsavedChanges } from "./UnsavedChangesGuard";

afterEach(cleanup);

function Harness({ onLeave }: { onLeave: () => void }) {
  const { dirty, runAfterDiscard, setDirty } = useUnsavedChanges();
  return (
    <>
      <span>{dirty ? "dirty" : "clean"}</span>
      <button onClick={() => setDirty(true)} type="button">修改</button>
      <button onClick={() => runAfterDiscard(onLeave)} type="button">离开</button>
    </>
  );
}

describe("UnsavedChangesProvider", () => {
  it("defers a dirty navigation until discard is confirmed", async () => {
    const user = userEvent.setup();
    const onLeave = vi.fn();
    render(<UnsavedChangesProvider><Harness onLeave={onLeave} /></UnsavedChangesProvider>);

    await user.click(screen.getByRole("button", { name: "修改" }));
    await user.click(screen.getByRole("button", { name: "离开" }));
    expect(onLeave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByText("dirty")).toBeInTheDocument();
    expect(onLeave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "离开" }));
    await user.click(screen.getByRole("button", { name: "放弃更改" }));
    expect(onLeave).toHaveBeenCalledOnce();
    expect(screen.getByText("clean")).toBeInTheDocument();
  });

  it("prevents beforeunload only while dirty", async () => {
    const user = userEvent.setup();
    render(<UnsavedChangesProvider><Harness onLeave={vi.fn()} /></UnsavedChangesProvider>);

    const cleanEvent = new Event("beforeunload", { cancelable: true });
    fireEvent(window, cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    await user.click(screen.getByRole("button", { name: "修改" }));
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    fireEvent(window, dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });
});
