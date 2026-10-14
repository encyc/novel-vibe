import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoginBloom } from "./LoginBloom";

describe("LoginBloom", () => {
  it("renders a decorative procedural flower without entering the accessibility tree", () => {
    const { container } = render(<LoginBloom />);
    const bloom = container.querySelector(".login-bloom");

    expect(bloom).toHaveAttribute("aria-hidden", "true");
    expect(bloom?.querySelectorAll(".login-bloom-petal")).toHaveLength(36);
    expect(bloom?.querySelector(".login-bloom-heart")).toBeInTheDocument();
    expect(bloom?.querySelector(".login-bloom-leaf")).not.toBeInTheDocument();
  });
});
