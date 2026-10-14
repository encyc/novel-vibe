import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceColophon } from "./WorkspaceColophon";

describe("WorkspaceColophon", () => {
  it("exposes module identity, path, and commands", () => {
    render(
      <WorkspaceColophon eyebrow="WORLD BUILDING · 01" title="世界设定" detail="worldview/world.md">
        <button type="button">保存文稿</button>
      </WorkspaceColophon>,
    );

    expect(screen.getByRole("banner", { name: "世界设定工作区" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "世界设定" })).toBeInTheDocument();
    expect(screen.getByText("WORLD BUILDING · 01")).toBeInTheDocument();
    expect(screen.getByText("worldview/world.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存文稿" })).toBeInTheDocument();
  });
});
