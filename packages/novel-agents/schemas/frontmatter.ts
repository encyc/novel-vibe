import { Type, type Static, type TSchema } from "@sinclair/typebox";

// ─── Document types ────────────────────────────────────────────────

export const DocType = Type.Union([
  Type.Literal("worldview"),
  Type.Literal("character"),
  Type.Literal("relationships"),
  Type.Literal("volume"),
  Type.Literal("chapter-skeleton"),
  Type.Literal("chapter-card"),
  Type.Literal("director-script"),
  Type.Literal("chapter-text"),
  Type.Literal("foreshadow"),
  Type.Literal("story-summary"),
  Type.Literal("character-state"),
]);

export type DocType = Static<typeof DocType>;

export const DocStatus = Type.Union([
  Type.Literal("draft"),
  Type.Literal("confirmed"),
  Type.Literal("locked"),
]);

export type DocStatus = Static<typeof DocStatus>;

// ─── Frontmatter schemas per doc type ─────────────────────────────

export const worldviewFrontmatter = Type.Object({
  type: Type.Literal("worldview"),
  category: Type.Union([
    Type.Literal("power_system"),
    Type.Literal("geography"),
    Type.Literal("faction"),
    Type.Literal("society"),
    Type.Literal("history"),
    Type.Literal("rule"),
  ]),
  name: Type.String(),
  status: DocStatus,
  importance: Type.Number({ minimum: 1, maximum: 10 }),
  related: Type.Object({
    characters: Type.Array(Type.String()),
    chapters: Type.Array(Type.Number()),
    world_elements: Type.Array(Type.String()),
  }),
});

export const characterFrontmatter = Type.Object({
  type: Type.Literal("character"),
  name: Type.String(),
  slug: Type.String(),
  role: Type.Union([
    Type.Literal("protagonist"),
    Type.Literal("antagonist"),
    Type.Literal("supporting"),
    Type.Literal("minor"),
  ]),
  status: DocStatus,
  tags: Type.Array(Type.String()),
  abilities: Type.Array(Type.String()),
  arc_stage: Type.Union([
    Type.Literal("origin"),
    Type.Literal("growth"),
    Type.Literal("crisis"),
    Type.Literal("transcendence"),
  ]),
  appears_in: Type.Array(Type.Number()),
});

export const chapterCardFrontmatter = Type.Object({
  type: Type.Literal("chapter-card"),
  chapter: Type.Number(),
  volume: Type.Number(),
  arc: Type.Number(),
  title: Type.String(),
  pov: Type.String(),
  status: DocStatus,
  characters: Type.Array(Type.String()),
  world_elements: Type.Array(Type.String()),
  foreshadow_plant: Type.Array(Type.String()),
  foreshadow_resolve: Type.Array(Type.String()),
  emotion_curve: Type.String(),
  ending_hook: Type.Optional(Type.String({ description: "章末拉力：本章收在哪类变化上（真相/新危机/被迫选择/误会/关系变化/爽点预告/余韵）" })),
});

export const directorScriptFrontmatter = Type.Object({
  type: Type.Literal("director-script"),
  chapter: Type.Number(),
  based_on: Type.String(),
  status: DocStatus,
  characters_ref: Type.Array(Type.String()),
  world_ref: Type.Array(Type.String()),
  prev_chapter: Type.Number(),
});

export const chapterTextFrontmatter = Type.Object({
  type: Type.Literal("chapter-text"),
  chapter: Type.Number(),
  volume: Type.Number(),
  pov: Type.String(),
  status: DocStatus,
  word_count: Type.Number(),
  characters_present: Type.Array(Type.String()),
  style_tags: Type.Array(Type.String()),
});

export const foreshadowFrontmatter = Type.Object({
  type: Type.Literal("foreshadow"),
  id: Type.String({ pattern: "^fs-\\d{3}$" }),
  description: Type.String(),
  importance: Type.Number({ minimum: 1, maximum: 10 }),
  plant_chapter: Type.Number(),
  planned_resolve: Type.Number(),
  actual_resolve: Type.Union([Type.Number(), Type.Null()]),
  status: Type.Union([
    Type.Literal("planned"),
    Type.Literal("planted"),
    Type.Literal("resolved"),
    Type.Literal("abandoned"),
  ]),
});

export const volumeFrontmatter = Type.Object({
  type: Type.Literal("volume"),
  volume: Type.Number(),
  title: Type.String(),
  status: DocStatus,
  chapters: Type.Array(Type.Number()),
  word_count_target: Type.Number(),
});

export const relationshipsFrontmatter = Type.Object({
  type: Type.Literal("relationships"),
  status: DocStatus,
  pairs: Type.Array(
    Type.Object({
      from: Type.String(),
      to: Type.String(),
      relation: Type.String(),
      tension: Type.String(),
    }),
  ),
});

export const chapterSkeletonFrontmatter = Type.Object({
  type: Type.Literal("chapter-skeleton"),
  volume: Type.Number(),
  status: DocStatus,
  chapter_range: Type.Tuple([Type.Number(), Type.Number()]),
  entries: Type.Array(Type.Object({
    chapter: Type.Number(),
    title: Type.String(),
    one_liner: Type.String(),
    arc: Type.Number(),
  })),
});

export const storySummaryFrontmatter = Type.Object({
  type: Type.Literal("story-summary"),
  status: DocStatus,
  latest_chapter: Type.Number({ description: "Latest chapter number covered by this summary" }),
  updated_at: Type.String({ description: "ISO timestamp of last update" }),
  word_count: Type.Number({ description: "Word count of the summary body" }),
});

export const characterStateFrontmatter = Type.Object({
  type: Type.Literal("character-state"),
  character: Type.String({ description: "Character slug this state tracks" }),
  status: DocStatus,
  latest_chapter: Type.Number({ description: "Latest chapter number covered by this state" }),
});

// ─── Schema registry ──────────────────────────────────────────────

export const frontmatterSchemas: Record<string, TSchema> = {
  worldview: worldviewFrontmatter,
  character: characterFrontmatter,
  relationships: relationshipsFrontmatter,
  volume: volumeFrontmatter,
  "chapter-skeleton": chapterSkeletonFrontmatter,
  "chapter-card": chapterCardFrontmatter,
  "director-script": directorScriptFrontmatter,
  "chapter-text": chapterTextFrontmatter,
  foreshadow: foreshadowFrontmatter,
  "story-summary": storySummaryFrontmatter,
  "character-state": characterStateFrontmatter,
};

export type FrontmatterSchemas = typeof frontmatterSchemas;
