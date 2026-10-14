import { readdir, readFile, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { parseCaseYaml, CaseSchemaError } from "./schema.ts";
import type { BenchCase } from "../types.ts";

export interface CaseLibrary {
  light: BenchCase[];
  heavy: BenchCase[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadLayer(dir: string, layer: "light" | "heavy"): Promise<BenchCase[]> {
  const layerDir = join(dir, layer);
  let entries: string[];
  try {
    entries = await readdir(layerDir);
  } catch {
    return [];
  }
  const cases: BenchCase[] = [];
  for (const name of entries.filter((n) => n.endsWith(".yaml")).sort()) {
    const filePath = join(layerDir, name);
    const raw = await readFile(filePath, "utf8");
    const benchCase = parseCaseYaml(`${layer}/${name}`, raw);
    if (benchCase.layer !== layer) {
      throw new CaseSchemaError(benchCase.id, `layer "${benchCase.layer}" does not match directory "${layer}/"`);
    }
    for (const setup of benchCase.setup) {
      const fixturePath = resolve(dirname(filePath), setup.fixture);
      if (!(await fileExists(fixturePath))) {
        throw new CaseSchemaError(benchCase.id, `fixture not found: ${setup.fixture} (for ${setup.path})`);
      }
    }
    cases.push(benchCase);
  }
  return cases;
}

/** Load and validate the whole case library. Throws (naming the case) on any invalid file. */
export async function loadCaseLibrary(casesDir: string): Promise<CaseLibrary> {
  const [light, heavy] = await Promise.all([loadLayer(casesDir, "light"), loadLayer(casesDir, "heavy")]);
  const seen = new Set<string>();
  for (const benchCase of [...light, ...heavy]) {
    if (seen.has(benchCase.id)) {
      throw new CaseSchemaError(benchCase.id, "duplicate case id");
    }
    seen.add(benchCase.id);
  }
  return { light, heavy };
}
