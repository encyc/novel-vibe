import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { ChatSession, Project, User } from "../types";
import { UnsavedChangesProvider } from "./UnsavedChangesGuard";
import { SessionRail } from "./SessionRail";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCreditSummary: vi.fn(async () => ({ balance: 100, totalGranted: 100, totalConsumed: 0, level: 1, levelName: "L1" })),
}));

const project: Project = { id: "p1", title: "长夜临渊", lifecycle_status: "active", creative_language: "zh-CN" };
const user: User = { id: "u1", email: "writer@example.com" };
const session = (patch: Partial<ChatSession> = {}): ChatSession => ({
  id: "s1", projectId: "p1", title: "人物讨论", isProcessing: false, memoryStatus: "healthy",
  messageCount: 1, lastMessageAt: "2026-08-20T08:00:00.000Z", createdAt: "2026-08-19T08:00:00.000Z", ...patch,
});

function renderCompactRail(sessions: ChatSession[] = [session()]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <MemoryRouter>
          <UnsavedChangesProvider>
            <SessionRail
              canCreate
              compact
              currentSessionId="s1"
              loading={false}
              onDelete={vi.fn()}
              onOpenManager={vi.fn()}
              onCreate={vi.fn()}
              onRename={vi.fn()}
              onSignedOut={vi.fn()}
              onSelect={vi.fn()}
              project={project}
              sessions={sessions}
              user={user}
            />
          </UnsavedChangesProvider>
        </MemoryRouter>
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("SessionRail compact icon rail", () => {
  it("renders 56px rail chrome without the full session list", () => {
    renderCompactRail();
    expect(document.querySelector('.session-rail[data-compact="true"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "新建总编会话" })).toBeInTheDocument();
    // Full-list chrome stays out of the compact rail.
    expect(document.querySelector(".rail-session-list")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "搜索总编会话" })).not.toBeInTheDocument();
    expect(screen.queryByText("长夜临渊")).not.toBeInTheDocument();
  });

  it("exposes session dots with current and processing states", () => {
    renderCompactRail([session(), session({ id: "s2", title: "大纲推演", isProcessing: true })]);
    const dots = document.querySelectorAll<HTMLElement>(".rail-mini-dot");
    expect(dots).toHaveLength(2);
    expect(dots[0].dataset.current).toBe("true");
    expect(dots[1].dataset.processing).toBeDefined();
  });
});
