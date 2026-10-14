import { describe, beforeEach } from "vitest";
import { createDbTestContext } from "./test-kit.js";

let ctx: ReturnType<typeof createDbTestContext>;

beforeEach(() => {
  ctx = createDbTestContext();
});

describe("upsertDocumentIndex", () => {
    it("calls POST with correct URL", async () => {
      ctx.mockOk();
      await ctx.db.upsertDocumentIndex({
        projectId: "proj-1",
        docPath: "characters/lin-fan.md",
        docType: "character",
        name: "林凡",
        status: "draft",
        meta: { type: "character" },
      });

      expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("/document_index");
      expect(opts.method).toBe("POST");
    });

    it("declares the composite unique columns used for conflict resolution", async () => {
      ctx.mockOk();
      await ctx.db.upsertDocumentIndex({
        projectId: "proj-1",
        docPath: "characters/lin-fan.md",
        docType: "character",
        meta: {},
      });

      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("on_conflict=project_id%2Cdoc_path");
    });

    it("sends merge-duplicates preference header", async () => {
      ctx.mockOk();
      await ctx.db.upsertDocumentIndex({
        projectId: "proj-1",
        docPath: "test.md",
        docType: "worldview",
        meta: {},
      });

      const headers = ctx.fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers?.Prefer).toBe("resolution=merge-duplicates");
    });

    it("sends word_count and checksum when provided", async () => {
      ctx.mockOk();
      await ctx.db.upsertDocumentIndex({
        projectId: "proj-1",
        docPath: "test.md",
        docType: "character",
        meta: {},
        wordCount: 100,
        checksum: "abc123",
      });

      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.word_count).toBe(100);
      expect(body.checksum).toBe("abc123");
    });

    it("sends null for optional fields when not provided", async () => {
      ctx.mockOk();
      await ctx.db.upsertDocumentIndex({
        projectId: "proj-1",
        docPath: "test.md",
        docType: "character",
        meta: {},
      });

      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.name).toBeNull();
      expect(body.chapter_num).toBeNull();
      expect(body.volume_num).toBeNull();
    });

    it("throws on non-ok response", async () => {
      ctx.mockError(500, "DB error");
      await expect(
        ctx.db.upsertDocumentIndex({ projectId: "p", docPath: "x.md", docType: "t", meta: {} }),
      ).rejects.toThrow("DB upsert failed");
    });
  });

describe("listDocuments", () => {
    it("builds URL with project_id filter and order", async () => {
      ctx.mockOk([{ id: 1 }]);
      await ctx.db.listDocuments("proj-1");

      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("project_id=eq.proj-1");
      expect(url).toContain("order=updated_at.desc");
    });

    it("adds doc_type filter when provided", async () => {
      ctx.mockOk([]);
      await ctx.db.listDocuments("proj-1", "character");

      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("doc_type=eq.character");
    });

    it("returns parsed JSON array", async () => {
      ctx.mockOk([{ id: 1 }, { id: 2 }]);
      const result = await ctx.db.listDocuments("p");
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it("throws on HTTP error", async () => {
      ctx.mockError();
      await expect(ctx.db.listDocuments("p")).rejects.toThrow("DB query failed");
    });
  });

describe("getDocument", () => {
    it("URL-encodes the doc_path", async () => {
      ctx.mockOk([{ id: 1 }]);
      await ctx.db.getDocument("proj-1", "characters/林 凡.md");

      const [url] = ctx.fetchMock.mock.calls[0];
      expect(url).toContain("project_id=eq.proj-1");
    });

    it("returns first row when found", async () => {
      ctx.mockOk([{ doc_path: "test.md", status: "draft" }]);
      const result = await ctx.db.getDocument("p", "test.md");
      expect(result).toEqual({ doc_path: "test.md", status: "draft" });
    });

    it("returns null when no rows found", async () => {
      ctx.mockOk([]);
      const result = await ctx.db.getDocument("p", "nonexistent.md");
      expect(result).toBeNull();
    });
  });

describe("updateDocumentStatus", () => {
    it("sends PATCH with status in body", async () => {
      ctx.mockOk();
      await ctx.db.updateDocumentStatus("proj-1", "test.md", "confirmed");

      const [url, opts] = ctx.fetchMock.mock.calls[0];
      expect(opts.method).toBe("PATCH");
      expect(url).toContain("project_id=eq.proj-1");
      expect(JSON.parse(opts.body as string)).toEqual({ status: "confirmed" });
    });

    it("throws on error", async () => {
      ctx.mockError();
      await expect(ctx.db.updateDocumentStatus("p", "t.md", "locked")).rejects.toThrow(
        "DB update failed",
      );
    });
  });

describe("upsertForeshadow", () => {
    it("sends all foreshadow fields in body", async () => {
      ctx.mockOk();
      await ctx.db.upsertForeshadow({
        projectId: "proj-1",
        foreshadowId: "fs-001",
        docPath: "foreshadowing/fs-001.md",
        description: "test",
        importance: 8,
        plantChapter: 1,
        plannedResolve: 5,
      });

      const body = JSON.parse(ctx.fetchMock.mock.calls[0][1]?.body as string);
      expect(body.project_id).toBe("proj-1");
      expect(body.foreshadow_id).toBe("fs-001");
      expect(body.importance).toBe(8);
      expect(body.plant_chapter).toBe(1);
    });

    it("uses merge-duplicates preference", async () => {
      ctx.mockOk();
      await ctx.db.upsertForeshadow({
        projectId: "p",
        foreshadowId: "fs-001",
        docPath: "x.md",
      });

      const headers = ctx.fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers?.Prefer).toBe("resolution=merge-duplicates");
    });

    it("throws on error", async () => {
      ctx.mockError();
      await expect(
        ctx.db.upsertForeshadow({ projectId: "p", foreshadowId: "fs-001", docPath: "x.md" }),
      ).rejects.toThrow("Foreshadow upsert failed");
    });
  });

describe("document version operations", () => {
    it("calls write lifecycle RPCs with encoded payloads", async () => {
      ctx.mockOkRaw([{ outcome: "claimed", version_id: "v1" }]);
      await ctx.db.claimDocumentWrite({
        projectId: "p1", path: "chapters/一.md", beforeHash: null, afterHash: "after",
        sourceType: "agent", agentId: "writer", leaseId: "l1", leaseExpiresAt: "later",
      });
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("/rpc/claim_document_write");
      expect(JSON.parse(ctx.fetchMock.mock.calls[0][1].body)).toMatchObject({
        p_project_id: "p1", p_doc_path: "chapters/一.md", p_agent_id: "writer",
      });

      ctx.mockOkRaw([{ version_no: 2 }]);
      await ctx.db.completeDocumentWrite({
        versionId: "v1", leaseId: "l1", beforeSnapshotPath: null,
        afterSnapshotPath: ".versions/a.md", diff: {
          algorithmVersion: "jsdiff-v1", status: "ready", hunks: [], frontmatterChanges: [],
          addedLines: 1, deletedLines: 0, changedSections: [], truncated: false,
        },
      });
      expect(String(ctx.fetchMock.mock.calls[1][0])).toContain("/rpc/complete_document_write");
      expect(JSON.parse(ctx.fetchMock.mock.calls[1][1].body).p_body_hunks).toEqual([]);

      ctx.mockOkRaw(null);
      await ctx.db.failDocumentWrite("v1", "l1", "storage_failed");
      expect(String(ctx.fetchMock.mock.calls[2][0])).toContain("/rpc/fail_document_write");
    });

    it("lists versions with escaped path and a descending cursor", async () => {
      ctx.mockOkRaw([]);
      await ctx.db.listDocumentVersions("p1", "chapters/一 空.md", 7, 21);
      const url = String(ctx.fetchMock.mock.calls[0][0]);
      expect(url).toContain("doc_path=eq.chapters%2F%E4%B8%80%20%E7%A9%BA.md");
      expect(url).toContain("version_no=lt.7");
      expect(url).toContain("order=version_no.desc");
      expect(url).toContain("limit=21");
    });

    it("reads joined metadata and claims repairs", async () => {
      ctx.mockOkRaw([{ id: "v1" }]);
      await ctx.db.getDocumentVersion("v1", "p1");
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("document_version_diffs");
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain("project_id=eq.p1");

      ctx.mockOkRaw([{ status: "ready" }]);
      await ctx.db.getDocumentVersionDiff("v1");
      expect(String(ctx.fetchMock.mock.calls[1][0])).toContain("/document_version_diffs?version_id=eq.v1");

      ctx.mockOkRaw([]);
      await ctx.db.claimDocumentVersionRepairs("2026-08-14T10:00:00.000Z", 5);
      expect(String(ctx.fetchMock.mock.calls[2][0])).toContain("/rpc/claim_document_version_repairs");
    });

    it("reads pricing windows and context tiers and persists a usage pricing snapshot", async () => {
      ctx.mockOkRaw([{ id: "window-1" }]);
      await ctx.db.listCreditRateTimeWindows();
      expect(String(ctx.fetchMock.mock.calls[0][0])).toContain(
        "/credit_rate_time_windows?is_active=eq.true&order=priority.desc",
      );

      ctx.mockOkRaw([{ id: "tier-high" }]);
      await ctx.db.listCreditRateContextTiers();
      expect(String(ctx.fetchMock.mock.calls[1][0])).toContain(
        "/credit_rate_context_tiers?is_active=eq.true&order=priority.desc",
      );

      ctx.mockOkRaw([{ id: "usage-1" }]);
      await ctx.db.insertUsageRecord({
        userId: "user-1", projectId: "project-1", agentId: "chief_editor",
        modelId: "deepseek-v4-pro", modelProvider: "opencode",
        inputTokens: 1000, outputTokens: 100, cacheReadTokens: 20,
        cacheWriteTokens: 0, totalTokens: 1120, costUsd: 0.01,
        creditsConsumed: 0.3, creditRateId: "rate-1",
        requestStartedAt: "2026-08-17T01:00:00.000Z", pricingPeriod: "peak",
        creditRateWindowId: "window-1",
        contextTokens: 272001,
        creditRateContextTierId: "tier-high",
        rateSnapshot: { version: 1, inputRate: 0.0924, outputRate: 0.2772, cacheReadRate: 0.00308, cacheWriteRate: 0 },
        billingMultiplier: 2,
      });
      expect(JSON.parse(ctx.fetchMock.mock.calls[2][1].body)).toMatchObject({
        request_started_at: "2026-08-17T01:00:00.000Z",
        pricing_period: "peak",
        credit_rate_window_id: "window-1",
        context_tokens: 272001,
        credit_rate_context_tier_id: "tier-high",
        rate_snapshot: { version: 1, inputRate: 0.0924 },
        billing_multiplier: 2,
      });
    });
  });
