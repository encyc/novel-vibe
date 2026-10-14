import { render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { IconButton } from "./IconButton";

describe("IconButton", () => {
  it("uses an accessible label without visible text", () => {
    render(
      <AppProviders>
        <IconButton label="设置"><Settings size={16} /></IconButton>
      </AppProviders>,
    );

    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });
});
