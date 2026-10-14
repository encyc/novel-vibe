import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("createSession", () => {
    it("sends POST with session fields", async () => {
      ctx.mockOk();
      await ctx.db.createSession({ id: "s1", projectId: "p1", title: "新会话" });

      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.id).toBe("s1");
      expect(body.project_id).toBe("p1");
      expect(body.title).toBe("新会话");
      expect(body.messages).toEqual([]);
      expect(body.is_processing).toBe(false);
    });

    it("does not throw on error, just logs", async () => {
      ctx.mockError();
      await expect(
        ctx.db.createSession({ id: "s1", projectId: "p1", title: "test" }),
      ).resolves.toBeUndefined();
    });
  });

describe("listSessions", () => {
    it("loads sessions with messages", async () => {
      // listSessions makes 2 calls: sessions query then messages for each session
      ctx.fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ id: "s1", project_id: "p1" }]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ id: "m1", role: "user" }]),
        });

      const sessions = await ctx.db.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].messages).toEqual([{ id: "m1", role: "user" }]);
      // Verify first call fetches sessions, second call fetches messages
      expect(ctx.fetchMock.mock.calls[0][0]).toContain("/sessions");
      expect(ctx.fetchMock.mock.calls[1][0]).toContain("/session_messages");
    });

    it("filters by owner's projects when ownerId provided", async () => {
      // listSessions with ownerId: projects query → sessions query → messages for each session
      ctx.fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ id: "p1" }]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ id: "s1", project_id: "p1" }]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ id: "m1", role: "user" }]),
        });

      const sessions = await ctx.db.listSessions("user-1");
      expect(sessions).toHaveLength(1);
      // The sessions query should filter by project IDs
      const sessionsCallUrl = ctx.fetchMock.mock.calls[1][0] as string;
      expect(sessionsCallUrl).toContain("project_id=in.(p1)");
    });

    it("returns empty when user has no projects", async () => {
      ctx.fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
      const sessions = await ctx.db.listSessions("user-1");
      expect(sessions).toEqual([]);
    });

    it("handles messages fetch failure gracefully", async () => {
      ctx.fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: "s1" }]) })
        .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve(null), text: () => Promise.resolve("error") });

      const sessions = await ctx.db.listSessions();
      expect(sessions[0].messages).toEqual([]);
    });
  });

describe("addMessage", () => {
    it("sends POST with message fields", async () => {
      ctx.fetchMock.mockResolvedValue({ ok: true }); // consistent mock for both calls

      await ctx.db.addMessage("s1", {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1234567890,
        model: "test-model",
      });

      expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.id).toBe("m1");
      expect(body.session_id).toBe("s1");
      expect(body.role).toBe("user");
      expect(body.model).toBe("test-model");
    });

    it("updates session last_message_at after adding message", async () => {
      ctx.fetchMock.mockResolvedValue({ ok: true });

      await ctx.db.addMessage("s1", {
        id: "m1",
        role: "user",
        content: [],
        timestamp: 1234567890,
      });

      // Second call should be PATCH to sessions
      expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
      const [, opts] = ctx.fetchMock.mock.calls[1];
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body as string);
      expect(body.last_message_at).toBeDefined();
    });
  });

describe("deleteSession", () => {
    it("sends DELETE request", async () => {
      ctx.mockOk();
      await ctx.db.deleteSession("s1");
      expect(ctx.fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    });
  });

describe("durable session data source", () => {
    it("acquires and releases leases through RPC endpoints", async () => {
      ctx.mockOkRaw(true);
      ctx.mockOkRaw(true);

      await expect(ctx.db.acquireSessionLease("s1", "lease-1", "2026-06-29T00:00:00.000Z"))
        .resolves.toBe(true);
      await expect(ctx.db.releaseSessionLease("s1", "lease-1")).resolves.toBe(true);

      expect(ctx.fetchMock.mock.calls[0][0]).toContain("/rpc/acquire_session_lease");
      expect(JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string)).toEqual({
        p_session_id: "s1",
        p_lease_id: "lease-1",
        p_stale_before: "2026-06-29T00:00:00.000Z",
      });
      expect(ctx.fetchMock.mock.calls[1][0]).toContain("/rpc/release_session_lease");
    });

    it("lists project sessions with stable ordering and a cursor", async () => {
      ctx.mockOk([{ id: "p1", owner_id: "u1" }]);
      ctx.mockOk([]);

      await ctx.db.listSessionRows({
        projectId: "p1",
        userId: "u1",
        limit: 6,
        cursor: { lastMessageAt: "2026-06-28T00:00:00.000Z", id: "s2" },
        search: "人物 动机",
      });

      const url = ctx.fetchMock.mock.calls[1][0] as string;
      expect(url).toContain("project_id=eq.p1");
      expect(url).toContain("order=last_message_at.desc,id.desc");
      expect(url).toContain("limit=6");
      expect(url).toContain("&or=");
      expect(decodeURIComponent(url)).toContain("title=ilike.*人物 动机*");
      expect(decodeURIComponent(url)).toContain("last_message_at.lt.2026-06-28T00:00:00.000Z");
    });

    it("does not return a session when its project belongs to another user", async () => {
      ctx.mockOk([{ id: "s1", project_id: "p1" }]);
      ctx.mockOk([]);

      await expect(ctx.db.getOwnedSessionRow("s1", "u1")).resolves.toBeNull();
      expect(ctx.fetchMock.mock.calls[1][0]).toContain("owner_id=eq.u1");
    });

    it("queries display and agent messages by deterministic sequence", async () => {
      ctx.mockOk([]);
      ctx.mockOk([]);

      await ctx.db.listDisplayMessageRows({ sessionId: "s1", limit: 21, cursor: { sequence: 10 } });
      await ctx.db.listAgentMessageRows("s1", "writer", 4);

      const displayUrl = decodeURIComponent(ctx.fetchMock.mock.calls[0][0] as string);
      expect(displayUrl).toContain("display=eq.true");
      expect(displayUrl).toContain("sequence=lt.10");
      expect(displayUrl).toContain("order=sequence.desc");
      const agentUrl = decodeURIComponent(ctx.fetchMock.mock.calls[1][0] as string);
      expect(agentUrl).toContain("agent_id=eq.writer");
      expect(agentUrl).toContain("sequence=gt.4");
    });

    it("claims and patches memory jobs through durable endpoints", async () => {
      ctx.mockOk([{ id: "job-1" }]);
      ctx.mockOk([]);

      await ctx.db.claimMemoryJobRows("2026-06-29T00:00:00.000Z", 5);
      await ctx.db.patchMemoryJobRow("job-1", { status: "complete" });

      expect(ctx.fetchMock.mock.calls[0][0]).toContain("/rpc/claim_memory_jobs");
      expect(JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string)).toEqual({
        p_now: "2026-06-29T00:00:00.000Z",
        p_limit: 5,
      });
      expect(ctx.fetchMock.mock.calls[1][0]).toContain("/memory_jobs?id=eq.job-1");
      expect(ctx.fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
    });

    it("reads and upserts memory exclusions", async () => {
      ctx.mockOk([{ external_memory_id: "m1" }]);
      ctx.mockOk([]);

      await ctx.db.listMemoryExclusionRows("p1");
      await ctx.db.insertMemoryExclusionRows([
        { project_id: "p1", deleted_session_id: "s1", external_memory_id: "m1" },
      ]);

      expect(ctx.fetchMock.mock.calls[0][0]).toContain("/memory_exclusions?project_id=eq.p1");
      expect(ctx.fetchMock.mock.calls[1][0]).toContain("on_conflict=project_id%2Cexternal_memory_id");
      expect(ctx.fetchMock.mock.calls[1][1]?.headers).toMatchObject({
        Prefer: "resolution=merge-duplicates",
      });
    });

    it("loads and upserts agent summary state", async () => {
      ctx.mockOk([{ summary: "摘要", summary_through_sequence: 4 }]);
      ctx.mockOk([]);

      await ctx.db.getAgentStateRow("s1", "writer");
      await ctx.db.upsertAgentStateRow({
        session_id: "s1",
        agent_id: "writer",
        summary: "摘要",
        summary_through_sequence: 4,
      });

      expect(ctx.fetchMock.mock.calls[0][0]).toContain("/session_agent_state?session_id=eq.s1&agent_id=eq.writer");
      expect(ctx.fetchMock.mock.calls[1][0]).toContain("on_conflict=session_id%2Cagent_id");
    });

    it("prepares memory deletion through one database RPC", async () => {
      ctx.mockOkRaw(true);
      await expect(ctx.db.prepareSessionMemoryDelete("s1")).resolves.toBe(true);
      expect(ctx.fetchMock.mock.calls[0][0]).toContain("/rpc/prepare_session_memory_delete");
      expect(JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string)).toEqual({
        p_session_id: "s1",
      });
    });
  });
