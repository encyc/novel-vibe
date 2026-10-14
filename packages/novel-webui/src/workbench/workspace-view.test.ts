import { describe, expect, it } from "vitest";
import { isWorkspaceViewId, resolveWorkspaceView } from "./workspace-view";

describe("workspace view registry", () => {
  it("resolves url ids and falls back to the manuscript workspace", () => {
    expect(resolveWorkspaceView("review")).toBe("review");
    expect(resolveWorkspaceView("agent")).toBe("agent");
    expect(resolveWorkspaceView("galaxy")).toBe("workspace");
    expect(resolveWorkspaceView(null)).toBe("workspace");
  });

  it("keeps the agent page out of the permanent tab list", () => {
    expect(isWorkspaceViewId("agent")).toBe(true);
    expect(isWorkspaceViewId("overview")).toBe(false);
  });
});
