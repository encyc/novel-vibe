/**
 * Read-only reference queries over the document index and foreshadow index —
 * the find-references / debt-list layer of the harness verifier stack
 * (verifier-stack spec Phase 2). Deterministic matching only: fuzzy entity
 * resolution is the calling agent's job.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { VARIANT_PATH_PATTERN } from "./variant-tools.js";
import type { ToolContext } from "./file-tools.js";

interface IndexRow {
  doc_path?: string;
  doc_type?: string;
  status?: string;
  chapter_num?: number | null;
  name?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Meta field paths that may hold the entity slug, per doc type. */
const REFERENCE_FIELDS: Record<string, string[][]> = {
  "chapter-text": [["characters_present"], ["pov"]],
  "chapter-card": [["characters"], ["world_elements"]],
  "director-script": [["characters_ref"], ["world_ref"]],
  worldview: [["related", "characters"], ["related", "world_elements"]],
};

const MAX_LISTED_REFS = 40;

function resolveAt(meta: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = meta;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function mentions(fieldValue: unknown, entity: string): boolean {
  const needle = entity.toLowerCase();
  const values = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
  return values.some((v) => typeof v === "string" && v.trim().toLowerCase() === needle);
}

export function matchEntity(docType: string, meta: Record<string, unknown>, entity: string): boolean {
  const fields = REFERENCE_FIELDS[docType];
  if (!fields) return false;
  return fields.some((path) => mentions(resolveAt(meta, path), entity));
}

// ─── query_references ─────────────────────────────────────────────

const queryReferencesParams = Type.Object({
  entity_slug: Type.String({ description: "Character or world-element slug to look up, e.g. 'lin-fan'. Exact match, case-insensitive." }),
});

export function createQueryReferencesTool(ctx: ToolContext): AgentTool<typeof queryReferencesParams> {
  return {
    name: "query_references",
    label: "Query References",
    description:
      "Find every indexed document that references a character/world-element slug (chapter appearances, chapter cards, director scripts, worldview links). Use before renaming/removing an entity to gauge the blast radius, and when picking POVs or planning chapters.",
    parameters: queryReferencesParams,
    execute: async (_, params) => {
      try {
        const docs: IndexRow[] = await ctx.db.listDocuments(ctx.projectId);
        const entity = params.entity_slug;

        const profile = docs.find(
          (d) => d.doc_type === "character"
            && typeof (d.meta as any)?.slug === "string"
            && ((d.meta as any).slug as string).toLowerCase() === entity.toLowerCase(),
        );

        const refs = docs.filter(
          (d): d is IndexRow & { doc_path: string; doc_type: string } =>
            typeof d.doc_path === "string"
            && typeof d.doc_type === "string"
            && !!d.meta && matchEntity(d.doc_type, d.meta, entity),
        );
        const characterRefs = refs.filter((r) => r.doc_type === "character");
        // Character docs are registry anchors (their `appears_in` list), not per-scene evidence.
        const evidence = refs.filter((r) => r.doc_type !== "character");

        const chapters = [...new Set(
          evidence.flatMap((r) => {
            const nums: number[] = [];
            if (typeof r.chapter_num === "number") nums.push(r.chapter_num);
            const appearsIn = resolveAt(r.meta ?? {}, ["appears_in"]);
            if (Array.isArray(appearsIn)) for (const n of appearsIn) if (typeof n === "number") nums.push(n);
            return nums;
          }),
        )].sort((a, b) => a - b);

        const lines: string[] = [];
        if (profile) {
          lines.push(`角色档案：${profile.doc_path}（${profile.status ?? "?"}${(profile.meta as any)?.arc_stage ? `, arc_stage=${(profile.meta as any).arc_stage}` : ""}）`);
        } else {
          lines.push(`没有找到 "${entity}" 的角色档案（crowd/one-shot 角色，仅被摘要引用）。`);
        }

        const grouped = new Map<string, IndexRow[]>();
        for (const r of evidence) {
          const list = grouped.get(r.doc_type) ?? [];
          list.push(r);
          grouped.set(r.doc_type, list);
        }
        for (const type of [...grouped.keys()].sort()) {
          const rows = grouped.get(type)!;
          lines.push(`- ${type} ×${rows.length}`);
          for (const row of rows.slice(0, MAX_LISTED_REFS)) {
            const povMark = row.doc_type === "chapter-text" && mentions(resolveAt(row.meta ?? {}, ["pov"]), entity)
              ? "，视角" : "";
            lines.push(`  [${row.status ?? "?"}] ${row.doc_path}${typeof row.chapter_num === "number" ? ` (ch${row.chapter_num}${povMark})` : ""}`);
          }
        }
        if (evidence.length > MAX_LISTED_REFS * grouped.size) {
          lines.push("  …（超出列表上限，详见 details）");
        }

        const summary = evidence.length === 0
          ? `"${entity}" 没有任何结构化引用记录。`
          : `"${entity}" 引用扫描：${evidence.length} 处结构化引用${chapters.length > 0 ? `，覆盖第 ${chapters[0]}–${chapters[chapters.length - 1]} 章` : ""}。`;
        const text = profile || evidence.length > 0
          ? `${summary}\n${lines.join("\n")}`
          : summary;

        return {
          content: [{ type: "text" as const, text }],
          details: {
            entity,
            total_refs: evidence.length,
            characters_docs: characterRefs.length,
            chapters,
            has_profile: !!profile,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Reference query error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── foreshadow_debt ──────────────────────────────────────────────

const foreshadowDebtParams = Type.Object({
  current_chapter: Type.Optional(Type.Number({ description: "Latest known chapter number. Omit to derive from the newest indexed chapter." })),
});

interface ForeshadowRow {
  foreshadow_id?: string;
  doc_path?: string;
  description?: string;
  importance?: number;
  plant_chapter?: number | null;
  planned_resolve?: number | null;
  actual_resolve?: number | null;
  status?: string;
}

const DUE_SOON_WINDOW = 2;

export function createForeshadowDebtTool(ctx: ToolContext): AgentTool<typeof foreshadowDebtParams> {
  return {
    name: "foreshadow_debt",
    label: "Foreshadow Debt",
    description:
      "List planted-but-unresolved foreshadows with their planned payoff chapters, flagging overdue and soon-due items. Use before outlining or writing so payoffs land on schedule instead of leaking into abandoned threads.",
    parameters: foreshadowDebtParams,
    execute: async (_, params) => {
      try {
        let currentChapter = params.current_chapter;
        if (typeof currentChapter !== "number") {
          const chapters: IndexRow[] = await ctx.db.listDocuments(ctx.projectId, "chapter-text");
          currentChapter = Math.max(0, ...chapters.map((d) => d.chapter_num ?? 0));
        }

        const rows: ForeshadowRow[] = await ctx.db.listForeshadows(ctx.projectId);
        const open = rows.filter((r) => r.status !== "resolved" && r.status !== "abandoned");
        const overdue = open.filter((r) => typeof r.planned_resolve === "number" && currentChapter >= r.planned_resolve);
        const dueSoon = open.filter((r) =>
          typeof r.planned_resolve === "number"
          && currentChapter < r.planned_resolve
          && r.planned_resolve - currentChapter <= DUE_SOON_WINDOW);
        const later = open.filter((r) =>
          typeof r.planned_resolve === "number" && r.planned_resolve - currentChapter > DUE_SOON_WINDOW);
        const unplanned = open.filter((r) => typeof r.planned_resolve !== "number");

        function render(rowsSubset: ForeshadowRow[]): string {
          return rowsSubset.map((r) =>
            `- ${r.foreshadow_id ?? "?"} [${r.status ?? "?"}] 埋设 ch${r.plant_chapter ?? "?"} → 计划回收 ch${r.planned_resolve ?? "?"}${r.importance != null ? `，重要性 ${r.importance}` : ""}：${(r.description ?? "").slice(0, 60)}`).join("\n");
        }

        const sections: string[] = [`伏笔台账（当前进度 ch${currentChapter}）：未回收 ${open.length} 笔`];
        if (overdue.length > 0) sections.push(`已超期 ${overdue.length} 笔（应尽快安排回收或改期）：\n${render(overdue)}`);
        if (dueSoon.length > 0) sections.push(`${DUE_SOON_WINDOW} 章内到期 ${dueSoon.length} 笔：\n${render(dueSoon)}`);
        if (later.length > 0) sections.push(`远期在册 ${later.length} 笔：\n${render(later)}`);
        if (unplanned.length > 0) sections.push(`未定回收章 ${unplanned.length} 笔：\n${render(unplanned)}`);
        if (open.length === 0) sections.push("没有未回收伏笔。");

        return {
          content: [{ type: "text" as const, text: sections.join("\n\n") }],
          details: {
            current_chapter: currentChapter,
            overdue: overdue.length,
            due_soon: dueSoon.length,
            open_later: later.length,
            unplanned: unplanned.length,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Foreshadow debt error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

export function createReferenceTools(ctx: ToolContext): AgentTool<any>[] {
  return [
    createQueryReferencesTool(ctx),
    createForeshadowDebtTool(ctx),
    createListVariantsTool(ctx),
  ];
}

// ─── list_variants ────────────────────────────────────────────────

const listVariantsParams = Type.Object({
  chapter_num: Type.Optional(Type.Number({ description: "Restrict to this chapter number. Omit to list every open variant." })),
});

export function createListVariantsTool(ctx: ToolContext): AgentTool<typeof listVariantsParams> {
  return {
    name: "list_variants",
    label: "List Chapter Variants",
    description:
      "List competing variant drafts (text/ch-NNN.x.md) with their status and frontmatter summary, next to the canonical chapter's state. Use before promoting a variant or when coordinating parallel drafts.",
    parameters: listVariantsParams,
    execute: async (_, params) => {
      try {
        const docs: IndexRow[] = await ctx.db.listDocuments(ctx.projectId, "chapter-text");
        const variants = docs.filter((d) =>
          typeof d.doc_path === "string"
          && VARIANT_PATH_PATTERN.test(d.doc_path)
          && (params.chapter_num === undefined || d.chapter_num === params.chapter_num));

        if (variants.length === 0) {
          const scope = params.chapter_num !== undefined ? `第 ${params.chapter_num} 章` : "当前项目";
          return {
            content: [{ type: "text" as const, text: `${scope}没有打开的变体草稿。` }],
            details: { count: 0 },
          };
        }

        const lines: string[] = [`打开的变体草稿 ${variants.length} 份：`];
        for (const v of variants) {
          lines.push(`- [${v.status ?? "?"}] ${v.doc_path}${typeof v.chapter_num === "number" ? ` (ch${v.chapter_num})` : ""}`);
          const fm = v.meta ?? {};
          if (Array.isArray(fm.style_tags)) lines.push(`    style: ${(fm.style_tags as unknown[]).join("/")}`);
          if (typeof fm.word_count === "number") lines.push(`    声明字数: ${fm.word_count}`);
        }
        const coveredChapters = [...new Set(variants.map((v) => v.chapter_num).filter((n): n is number => typeof n === "number"))];
        const canonicals = docs.filter((d) =>
          typeof d.doc_path === "string"
          && !VARIANT_PATH_PATTERN.test(d.doc_path)
          && coveredChapters.includes(d.chapter_num as number));
        if (canonicals.length > 0) {
          lines.push("对应正典路径状态：");
          for (const c of canonicals) {
            lines.push(`- [${c.status ?? "?"}] ${c.doc_path}`);
          }
        }
        lines.push("提示：变体必须保持 draft；选定后由 Chief Editor 用 promote_variant 晋升。");

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { count: variants.length, chapters: coveredChapters },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Variant listing error: ${err.message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}
