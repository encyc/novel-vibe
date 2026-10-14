# ADR 0004: Split Canon Structure Queries, Process Memory and Canon Epistemic Projections

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Novel Vibe now carries three durable knowledge surfaces, and each answers a different kind of agent question:

1. **Canon structure** — `document_index` / `foreshadow_index`, regenerated transactionally by `write_doc` (`lib/document-indexing.ts`) and exposed through deterministic read-only tools `query_references` / `foreshadow_debt` (verifier-stack spec, Phase 2).
2. **Process memory** — Memori-backed project memory; captured asynchronously from chat turns via `novel.memory_jobs` and pushed into every turn by SessionService as a `<project_memory>` block (`session/service.ts`). The agent cannot choose when or what to recall.
3. **Canon epistemic state** — the Agent Knowledge Base design (`docs/superpowers/specs/2026-08-19-agent-knowledge-base-design.md`，私有运维仓): evidence-coordinated observations folded into projections that distinguish what characters know/believe (lies, rumors, plans) from authorial truth. Designed but not yet implemented; today `character-state` documents and frontmatter fields act as transitional proxies.

Without a written division, two failure modes are likely: the memory capture pipeline double-bookkeeping facts that already live canonically in frontmatter (drift between copies), and callers using approximate semantic recall where an operation demands exhaustive consistency with on-disk documents — impact analysis before changing worldbuilding being the canonical example.

## Decision

Classify every knowledge question into exactly one of three homes, and bind consumers to the home:

| Question class | Authoritative home | Query semantics |
|---|---|---|
| “哪些正典文档引用了实体 X？”（结构导航） | index 层：`query_references` / `foreshadow_debt` | 精确匹配、与文件写路径同步、必须保证穷举 |
| “协作过程中说过/决定过什么？”（过程记忆） | Memori 项目记忆，系统每轮自动注入 | 语义近似、advisory、永不作为正典事实的出处 |
| “叙事内角色此刻知道/相信什么？”（认知状态） | KB 投影层（2026-08-19 设计落地后） | 带证据坐标与认识论分类的结构化查询 |

Binding rules:

- Any answer that must be exhaustively consistent with on-disk documents MUST come from the index layer — never from memory recall or free-form retrieval alone.
- Memory is never an authority for canon facts. Its capture pipeline SHOULD skip content already canonicalized in project documents rather than storing a second copy.
- Once KB projections land, they own semantic state queries; the index layer remains purely structural (reverse-reference navigation) and keeps its tool interfaces unchanged.
- Tool surfaces stay stable across storage rebasing: `foreshadow_debt` may switch its data source from `foreshadow_index` rows to observation-driven events without an interface change.
- New capability designs start by classifying their question into one row above before choosing a store; one fact has exactly one authoritative home — files-plus-index for canon structure, projections for epistemic state, memory for collaboration history.

## Consequences

- No redundant truth: eliminates double bookkeeping between frontmatter/index and project memory, and pre-empts a future duplicate of reference scanning inside the KB.
- The transition period (frontmatter proxies for epistemic state) is acknowledged explicitly; delivering the KB should include migrating state-style read paths away from frontmatter.
- Impact analysis, variant promotion and similar governance operations have a defined correctness source and cannot quietly degrade into fuzzy recall.
- Routing reviews for future agent tools become mechanical: check the question class first.

## Amendment (2026-08-31)

第三行（认知状态）的归属改判：Agent Knowledge Base 设计（2026-08-19）已被 `docs/superpowers/specs/2026-08-31-agent-memory-files-grep-design.md`（私有运维仓）取代，KB 投影层不再建设。认知状态问题的权威家改为**笔记层**：supervisor 园丁维护的追加式 Markdown（story-so-far 按章追加节、character-state 按章追加节 + 内联出处 + `latest_chapter` 新鲜度声明），查询语义为 grep/读文件 + `notes_health` 确定性 lint，语义近似、advisory、永不作为正典事实的出处。`character-state` 文档不再是"过渡代理"，它就是正式归属。第一行（index 层）与第二行（Memori 过程记忆）不变。
