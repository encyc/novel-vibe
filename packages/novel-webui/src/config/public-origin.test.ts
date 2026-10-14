import { describe, expect, it } from "vitest";
import { appUrl, communityUrl } from "./public-origin";

describe("communityUrl", () => {
  it("builds canonical main-domain URLs while preserving path and query", () => {
    expect(communityUrl("/article-1?source=app", "https://app.lingqiai.art"))
      .toBe("https://lingqiai.art/community/article-1?source=app");
  });

  it("keeps community navigation on the local development origin", () => {
    expect(communityUrl("/article-1", "http://localhost:5173"))
      .toBe("http://localhost:5173/community/article-1");
  });

  it("builds application URLs on the app subdomain", () => {
    expect(appUrl("/login", "https://lingqiai.art")).toBe("https://app.lingqiai.art/login");
    expect(appUrl("/profile", "https://lingqiai.art")).toBe("https://app.lingqiai.art/profile");
  });

  it("keeps application navigation on localhost and loopback origins", () => {
    expect(appUrl("/projects", "http://localhost:5173")).toBe("http://localhost:5173/projects");
    expect(appUrl("/login", "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/login");
  });
});
