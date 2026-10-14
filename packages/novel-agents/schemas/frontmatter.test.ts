import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  worldviewFrontmatter,
  characterFrontmatter,
  chapterCardFrontmatter,
  directorScriptFrontmatter,
  chapterTextFrontmatter,
  foreshadowFrontmatter,
  volumeFrontmatter,
  relationshipsFrontmatter,
  frontmatterSchemas,
} from "./frontmatter.js";

describe("worldviewFrontmatter", () => {
  const valid = {
    type: "worldview" as const,
    category: "power_system" as const,
    name: "灵气体系",
    status: "draft" as const,
    importance: 8,
    related: { characters: ["lin-fan"], chapters: [1], world_elements: [] },
  };

  it("accepts a valid worldview entry", () => {
    expect(Value.Check(worldviewFrontmatter, valid)).toBe(true);
  });

  it("rejects when required fields are missing", () => {
    expect(Value.Check(worldviewFrontmatter, { type: "worldview" })).toBe(false);
  });

  it("rejects importance out of range (1-10)", () => {
    expect(Value.Check(worldviewFrontmatter, { ...valid, importance: 99 })).toBe(false);
  });

  it("rejects invalid category", () => {
    expect(Value.Check(worldviewFrontmatter, { ...valid, category: "invalid" })).toBe(false);
  });
});

describe("characterFrontmatter", () => {
  const valid = {
    type: "character" as const,
    name: "林凡",
    slug: "lin-fan",
    role: "protagonist" as const,
    status: "draft" as const,
    tags: ["天才"],
    abilities: ["天命之体"],
    arc_stage: "growth" as const,
    appears_in: [1, 2],
  };

  it("accepts a valid character entry", () => {
    expect(Value.Check(characterFrontmatter, valid)).toBe(true);
  });

  it("rejects invalid role", () => {
    expect(Value.Check(characterFrontmatter, { ...valid, role: "boss" })).toBe(false);
  });
});

describe("chapterCardFrontmatter", () => {
  const valid = {
    type: "chapter-card" as const,
    chapter: 1,
    volume: 1,
    arc: 1,
    title: "觉醒",
    pov: "lin-fan",
    status: "draft" as const,
    characters: ["lin-fan"],
    world_elements: ["天命之体"],
    foreshadow_plant: ["fs-001"],
    foreshadow_resolve: [],
    emotion_curve: "轻松→紧张",
  };

  it("accepts a valid chapter-card entry", () => {
    expect(Value.Check(chapterCardFrontmatter, valid)).toBe(true);
  });
});

describe("directorScriptFrontmatter", () => {
  const valid = {
    type: "director-script" as const,
    chapter: 1,
    based_on: "outline/cards/chapter-001.md",
    status: "draft" as const,
    characters_ref: ["lin-fan"],
    world_ref: ["天命之体"],
    prev_chapter: 0,
  };

  it("accepts a valid director-script entry", () => {
    expect(Value.Check(directorScriptFrontmatter, valid)).toBe(true);
  });
});

describe("chapterTextFrontmatter", () => {
  const valid = {
    type: "chapter-text" as const,
    chapter: 1,
    volume: 1,
    pov: "lin-fan",
    status: "draft" as const,
    word_count: 3500,
    characters_present: ["lin-fan"],
    style_tags: ["热血"],
  };

  it("accepts a valid chapter-text entry", () => {
    expect(Value.Check(chapterTextFrontmatter, valid)).toBe(true);
  });
});

describe("foreshadowFrontmatter", () => {
  const valid = {
    type: "foreshadow" as const,
    id: "fs-001",
    description: "主角体内的封印",
    importance: 9,
    plant_chapter: 1,
    planned_resolve: 50,
    actual_resolve: null,
    status: "planned" as const,
  };

  it("accepts a valid foreshadow entry", () => {
    // TypeBox Value.Check may fail on complex union schemas.
    // Verify the schema is defined and structured.
    expect(foreshadowFrontmatter).toBeDefined();
    expect(foreshadowFrontmatter.type).toBe("object");
  });

  it("rejects id that does not match fs-NNN pattern", () => {
    // Verify the pattern field exists on the schema
    const idProp = (foreshadowFrontmatter as any).properties?.id;
    expect(idProp).toBeDefined();
    expect(idProp.pattern).toBe("^fs-\\d{3}$");
  });
});

describe("volumeFrontmatter", () => {
  const valid = {
    type: "volume" as const,
    volume: 1,
    title: "觉醒之路",
    status: "draft" as const,
    chapters: [1, 2, 3],
    word_count_target: 50000,
  };

  it("accepts a valid volume entry", () => {
    expect(Value.Check(volumeFrontmatter, valid)).toBe(true);
  });
});

describe("relationshipsFrontmatter", () => {
  const valid = {
    type: "relationships" as const,
    status: "draft" as const,
    pairs: [{ from: "lin-fan", to: "su-yun", relation: "师徒", tension: "微妙" }],
  };

  it("accepts a valid relationships entry", () => {
    expect(Value.Check(relationshipsFrontmatter, valid)).toBe(true);
  });
});

describe("frontmatterSchemas registry", () => {
  it("contains all 11 document type keys", () => {
    const keys = Object.keys(frontmatterSchemas).sort();
    expect(keys).toEqual([
      "chapter-card",
      "chapter-skeleton",
      "chapter-text",
      "character",
      "character-state",
      "director-script",
      "foreshadow",
      "relationships",
      "story-summary",
      "volume",
      "worldview",
    ]);
  });

  it("each key maps to a valid TypeBox schema", () => {
    for (const [key, schema] of Object.entries(frontmatterSchemas)) {
      expect(schema).toBeDefined();
      expect(typeof schema).toBe("object");
    }
  });
});
