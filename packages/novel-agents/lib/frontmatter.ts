import crypto from "node:crypto";

/** Parsed result from a Markdown file with YAML frontmatter. */
export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

/**
 * Parse YAML frontmatter from a Markdown string.
 * Frontmatter is delimited by `---` at the start of the file.
 */
export function parseFrontmatter(content: string): ParsedDocument {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content, raw: content };
  }

  const endMatch = trimmed.indexOf("\n---", 3);
  if (endMatch === -1) {
    return { frontmatter: {}, body: content, raw: content };
  }

  const yamlStr = trimmed.slice(3, endMatch).trim();
  const body = trimmed.slice(endMatch + 4).trimStart();

  const frontmatter = parseYamlSimple(yamlStr);

  return { frontmatter, body, raw: content };
}

/**
 * Minimal YAML parser for flat + one-level-nested structures.
 * Handles the frontmatter shapes used in Novel Vibe documents.
 */
function parseYamlSimple(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let lineIndex = 0;
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentObj: Record<string, unknown> | null = null;
  let currentArrayObj: Record<string, unknown> | null = null;
  let inNested = false;

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    lineIndex++;
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (inNested && currentArray && currentArrayObj && line.startsWith("    ") && !trimmed.startsWith("-")) {
      const [k, ...rest] = trimmed.split(":");
      const val = rest.join(":").trim();
      if (k) currentArrayObj[k.trim()] = parseValue(val);
      continue;
    }

    // Nested object key (indented, not starting with -)
    if (inNested && currentKey && line.startsWith("  ") && !trimmed.startsWith("-")) {
      const [k, ...rest] = trimmed.split(":");
      const val = rest.join(":").trim();
      if (currentObj && k) {
        currentObj[k.trim()] = parseValue(val);
      }
      continue;
    }

    // Array item
    if (inNested && currentKey && trimmed.startsWith("- ")) {
      if (currentArray) {
        const item = trimmed.slice(2).trim();
        const colonIdx = item.indexOf(":");
        if (colonIdx !== -1) {
          const key = item.slice(0, colonIdx).trim();
          const val = item.slice(colonIdx + 1).trim();
          currentArrayObj = { [key]: parseValue(val) };
          currentArray.push(currentArrayObj);
        } else {
          currentArrayObj = null;
          currentArray.push(parseValue(item));
        }
      }
      continue;
    }

    // End nested block
    if (inNested && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (currentKey && currentArray !== null) {
        result[currentKey] = currentArray;
      } else if (currentKey && currentObj) {
        result[currentKey] = currentObj;
      }
      inNested = false;
      currentKey = null;
      currentArray = null;
      currentObj = null;
      currentArrayObj = null;
    }

    // Top-level key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();

    if (val === "") {
      // Start of nested block — peek next line to determine array vs object
      currentKey = key;
      const nextLine = lines[lineIndex]?.trimStart() ?? "";
      if (nextLine.startsWith("- ")) {
        currentArray = [];
        currentArrayObj = null;
        inNested = true;
      } else {
        currentObj = {};
        inNested = true;
      }
    } else {
      result[key] = parseValue(val);
    }
  }

  // Flush any remaining nested block
  if (inNested && currentKey) {
    if (currentArray !== null) {
      result[currentKey] = currentArray;
    } else if (currentObj) {
      result[currentKey] = currentObj;
    }
  }

  return result;
}

function parseValue(val: string): unknown {
  if (val === "null" || val === "~") return null;
  if (val === "true") return true;
  if (val === "false") return false;
  if (val.startsWith("[") && val.endsWith("]")) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseValue(item.trim()));
  }
  if (val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1);
  if (val.startsWith("'") && val.endsWith("'")) return val.slice(1, -1);
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
  return val;
}

/** Count Chinese + ASCII words in text. */
export function countWords(text: string): number {
  // Chinese characters
  const chinese = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  // English words
  const english = text.replace(/[一-鿿㐀-䶿]/g, " ").split(/\s+/).filter(w => w.length > 0).length;
  return chinese + english;
}

/** Compute SHA-256 checksum of content. */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Get the doc_type directory for a given type. */
export function getDocDir(type: string): string {
  const dirMap: Record<string, string> = {
    worldview: "worldview",
    character: "characters",
    relationships: "characters",
    volume: "outline",
    "chapter-skeleton": "outline",
    "chapter-card": "outline",
    "director-script": "scripts",
    "chapter-text": "text",
    foreshadow: "foreshadowing",
    "story-summary": "summary",
    "character-state": "characters",
  };
  return dirMap[type] ?? "misc";
}
