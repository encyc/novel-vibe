import { createHash } from "node:crypto";
import {
  parseOpenCodeEndpoint,
  runtimeFingerprint,
  type RuntimeDefaults,
} from "../model-runtime/endpoint.js";
import type { RuntimeModelSource } from "../model-runtime/types.js";

export const OPENCODE_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_PRICING_URL =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx";
export const OPENCODE_PARSER_VERSION = "2";

export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CatalogTimeWindow {
  label: string;
  startMinuteUtc: number;
  endMinuteUtc: number;
  rates: TokenRates;
}

export interface CatalogContextTier {
  label: string;
  minContextTokens: number;
  maxContextTokens: number | null;
  rates: TokenRates;
}

export interface CatalogModelPrice {
  id: string;
  name: string;
  baseRates: TokenRates;
  timeWindows: CatalogTimeWindow[];
  contextTiers: CatalogContextTier[];
  runtime: RuntimeDefaults & {
    source: RuntimeModelSource;
    runtimeFingerprint: string;
  };
}

export interface OpenCodeCandidate {
  parserVersion: string;
  sourceHashes: { models: string; pricing: string };
  observedModelIds: string[];
  unsupportedEndpointModelIds: string[];
  /** @deprecated Use unsupportedEndpointModelIds. */
  unsupportedModelIds: string[];
  unpricedRuntimeModelIds: string[];
  models: CatalogModelPrice[];
}

export interface OpenCodeSources {
  modelsJson: unknown;
  pricingMarkdown: string;
}

interface PriceRow {
  name: string;
  qualifier: "normal" | "off_peak" | "peak" | "at_most" | "over";
  thresholdTokens?: number;
  rates: TokenRates;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function findTable(markdown: string, requiredHeaders: string[]): string[][] {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.trim().startsWith("|")) continue;
    const headers = splitTableRow(lines[index]!);
    if (!requiredHeaders.every((header) => headers.includes(header))) continue;

    const rows: string[][] = [];
    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex]!.trim();
      if (!line.startsWith("|")) break;
      const cells = splitTableRow(line);
      if (!isSeparatorRow(cells)) rows.push(cells);
    }
    return [headers, ...rows];
  }
  throw new Error(`OpenCode document is missing ${requiredHeaders.join("/")} table`);
}

function parseRate(value: string, allowDash: boolean): number {
  const normalized = value.trim();
  if (normalized === "-" && allowDash) return 0;
  if (/^free$/i.test(normalized)) return 0;
  const match = normalized.match(/^\$([0-9]+(?:\.[0-9]+)?)$/);
  if (!match) throw new Error(`Invalid OpenCode price: ${value}`);
  const result = Number(match[1]);
  if (!Number.isFinite(result) || result < 0) throw new Error(`Invalid OpenCode price: ${value}`);
  return result;
}

function parseTokenSize(value: string): number {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KM])?$/i);
  if (!match) throw new Error(`Invalid OpenCode context threshold: ${value}`);
  const multiplier = match[2]?.toUpperCase() === "M" ? 1_000_000 : match[2] ? 1_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function parsePriceName(value: string): Pick<PriceRow, "name" | "qualifier" | "thresholdTokens"> {
  const special = value.match(/^(.*?)\s+\((Off-Peak|Peak|≤\s*([0-9.]+\s*[KM]?)\s+tokens|>\s*([0-9.]+\s*[KM]?)\s+tokens)\)$/i);
  if (!special) return { name: value.trim(), qualifier: "normal" };
  const qualifier = special[2]!.toLowerCase();
  if (qualifier === "off-peak") return { name: special[1]!.trim(), qualifier: "off_peak" };
  if (qualifier === "peak") return { name: special[1]!.trim(), qualifier: "peak" };
  if (special[3]) {
    return { name: special[1]!.trim(), qualifier: "at_most", thresholdTokens: parseTokenSize(special[3]) };
  }
  return { name: special[1]!.trim(), qualifier: "over", thresholdTokens: parseTokenSize(special[4]!) };
}

function parsePeakWindows(markdown: string, rates: TokenRates): CatalogTimeWindow[] {
  const peakLine = markdown.split(/\r?\n/).find((line) => /Peak hours are/i.test(line));
  if (!peakLine) throw new Error("OpenCode Peak prices are present but Peak hours are missing");
  const windows: CatalogTimeWindow[] = [];
  const pattern = /(\d{2}):(\d{2})-(\d{2}):(\d{2})/g;
  for (const match of peakLine.matchAll(pattern)) {
    const startMinuteUtc = Number(match[1]) * 60 + Number(match[2]);
    const endMinuteUtc = Number(match[3]) * 60 + Number(match[4]);
    if (startMinuteUtc < 0 || endMinuteUtc > 1440 || startMinuteUtc >= endMinuteUtc) {
      throw new Error(`Invalid OpenCode Peak window: ${match[0]}`);
    }
    windows.push({ label: `peak_${windows.length + 1}`, startMinuteUtc, endMinuteUtc, rates });
  }
  if (windows.length === 0) throw new Error("OpenCode Peak hours contain no valid windows");
  windows.sort((left, right) => left.startMinuteUtc - right.startMinuteUtc);
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index]!.startMinuteUtc < windows[index - 1]!.endMinuteUtc) {
      throw new Error("OpenCode Peak windows overlap");
    }
  }
  return windows;
}

function parseModelIds(modelsJson: unknown): string[] {
  if (!modelsJson || typeof modelsJson !== "object" || !Array.isArray((modelsJson as { data?: unknown }).data)) {
    throw new Error("Invalid OpenCode models response: expected a data array");
  }
  const ids = (modelsJson as { data: unknown[] }).data.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") {
      throw new Error("Invalid OpenCode models response: every model must have an id");
    }
    return (entry as { id: string }).id.trim();
  });
  if (ids.some((id) => id.length === 0)) throw new Error("Invalid OpenCode models response: empty model id");
  const uniqueIds = [...new Set(ids)].sort();
  if (uniqueIds.length === 0) throw new Error("Invalid OpenCode models response: empty model list");
  return uniqueIds;
}

export function parseOpenCodeCandidate(input: {
  modelsJson: unknown;
  pricingMarkdown: string;
  runtimeModelIds: ReadonlySet<string>;
}): OpenCodeCandidate {
  const observedModelIds = parseModelIds(input.modelsJson);
  const endpointTable = findTable(input.pricingMarkdown, ["Model", "Model ID", "Endpoint"]);
  const endpointHeaders = endpointTable[0]!;
  const endpointNameIndex = endpointHeaders.indexOf("Model");
  const endpointIdIndex = endpointHeaders.indexOf("Model ID");
  const endpointUrlIndex = endpointHeaders.indexOf("Endpoint");
  const namesById = new Map<string, string>();
  const idsByName = new Map<string, string>();
  const endpointsById = new Map<string, string>();
  for (const cells of endpointTable.slice(1)) {
    const name = cells[endpointNameIndex]?.replace(/`/g, "").trim();
    const id = cells[endpointIdIndex]?.replace(/`/g, "").trim();
    const endpoint = cells[endpointUrlIndex]?.replace(/`/g, "").trim();
    if (name && id && endpoint) {
      if ((namesById.has(id) && namesById.get(id) !== name)
        || (idsByName.has(name) && idsByName.get(name) !== id)
        || (endpointsById.has(id) && endpointsById.get(id) !== endpoint)) {
        throw new Error(`Ambiguous OpenCode model mapping: ${name}/${id}`);
      }
      namesById.set(id, name);
      idsByName.set(name, id);
      endpointsById.set(id, endpoint);
    }
  }

  const priceTable = findTable(input.pricingMarkdown, ["Model", "Input", "Output", "Cached Read", "Cached Write"]);
  const priceHeaders = priceTable[0]!;
  const indices = {
    model: priceHeaders.indexOf("Model"),
    input: priceHeaders.indexOf("Input"),
    output: priceHeaders.indexOf("Output"),
    cacheRead: priceHeaders.indexOf("Cached Read"),
    cacheWrite: priceHeaders.indexOf("Cached Write"),
  };
  const pricesByName = new Map<string, PriceRow[]>();
  for (const cells of priceTable.slice(1)) {
    const parsedName = parsePriceName(cells[indices.model]!);
    const row: PriceRow = {
      ...parsedName,
      rates: {
        input: parseRate(cells[indices.input]!, false),
        output: parseRate(cells[indices.output]!, false),
        cacheRead: parseRate(cells[indices.cacheRead]!, true),
        cacheWrite: parseRate(cells[indices.cacheWrite]!, true),
      },
    };
    const existingRows = pricesByName.get(row.name) ?? [];
    const qualifierKey = `${row.qualifier}:${row.thresholdTokens ?? ""}`;
    if (existingRows.some((existing) => `${existing.qualifier}:${existing.thresholdTokens ?? ""}` === qualifierKey)) {
      throw new Error(`Duplicate OpenCode pricing qualifier for ${row.name}: ${qualifierKey}`);
    }
    pricesByName.set(row.name, [...existingRows, row]);
  }
  if (pricesByName.size === 0) throw new Error("OpenCode pricing table is empty");

  const models: CatalogModelPrice[] = [];
  const unsupportedEndpointModelIds: string[] = [];
  const unpricedRuntimeModelIds: string[] = [];
  for (const id of observedModelIds) {
    const endpoint = endpointsById.get(id);
    let runtime: RuntimeDefaults;
    try {
      if (!endpoint) throw new Error("missing endpoint");
      runtime = parseOpenCodeEndpoint(id, endpoint);
    } catch {
      unsupportedEndpointModelIds.push(id);
      continue;
    }
    const name = namesById.get(id);
    const rows = name ? pricesByName.get(name) : undefined;
    if (!name || !rows?.length) {
      unpricedRuntimeModelIds.push(id);
      continue;
    }

    const normal = rows.find((row) => row.qualifier === "normal");
    const offPeak = rows.find((row) => row.qualifier === "off_peak");
    const peak = rows.find((row) => row.qualifier === "peak");
    const atMost = rows.find((row) => row.qualifier === "at_most");
    const over = rows.find((row) => row.qualifier === "over");
    const modes = Number(Boolean(normal)) + Number(Boolean(offPeak || peak)) + Number(Boolean(atMost || over));
    if (modes !== 1) throw new Error(`Ambiguous OpenCode pricing rows for ${id}`);

    if (normal) {
      models.push({
        id, name, baseRates: normal.rates, timeWindows: [], contextTiers: [],
        runtime: withRuntimeIdentity(id, runtime, input.runtimeModelIds),
      });
    } else if (offPeak && peak) {
      models.push({
        id,
        name,
        baseRates: offPeak.rates,
        timeWindows: parsePeakWindows(input.pricingMarkdown, peak.rates),
        contextTiers: [],
        runtime: withRuntimeIdentity(id, runtime, input.runtimeModelIds),
      });
    } else if (atMost && over && atMost.thresholdTokens === over.thresholdTokens) {
      models.push({
        id,
        name,
        baseRates: atMost.rates,
        timeWindows: [],
        contextTiers: [{
          label: `over_${Math.round(over.thresholdTokens! / 1000)}k`,
          minContextTokens: over.thresholdTokens! + 1,
          maxContextTokens: null,
          rates: over.rates,
        }],
        runtime: withRuntimeIdentity(id, runtime, input.runtimeModelIds),
      });
    } else {
      throw new Error(`Incomplete OpenCode special pricing rows for ${id}`);
    }
  }

  return {
    parserVersion: OPENCODE_PARSER_VERSION,
    sourceHashes: {
      models: sha256(JSON.stringify(input.modelsJson)),
      pricing: sha256(input.pricingMarkdown),
    },
    observedModelIds,
    unsupportedEndpointModelIds,
    unsupportedModelIds: unsupportedEndpointModelIds,
    unpricedRuntimeModelIds,
    models,
  };
}

function withRuntimeIdentity(
  modelId: string,
  runtime: RuntimeDefaults,
  builtinModelIds: ReadonlySet<string>,
): CatalogModelPrice["runtime"] {
  return {
    ...runtime,
    source: builtinModelIds.has(modelId) ? "pi-ai" : "opencode-dynamic",
    runtimeFingerprint: runtimeFingerprint({
      modelId,
      endpoint: runtime.endpoint,
      api: runtime.api,
      parserVersion: OPENCODE_PARSER_VERSION,
    }),
  };
}

async function fetchWithRetry(
  url: string,
  fetcher: typeof fetch,
  retryDelaysMs: number[],
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: { accept: "*/*", "user-agent": "Novel-Vibe-Scheduler/1.0" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.url && !response.url.startsWith("https://")) {
        throw new Error(`OpenCode source redirected to a non-HTTPS URL: ${response.url}`);
      }
      if (response.ok) return response;
      lastError = new Error(`OpenCode source returned HTTP ${response.status}: ${url}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retryDelaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to fetch OpenCode source: ${url}`);
}

export async function fetchOpenCodeSources(options: {
  fetcher?: typeof fetch;
  retryDelaysMs?: number[];
  timeoutMs?: number;
} = {}): Promise<OpenCodeSources> {
  const fetcher = options.fetcher ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? [1_000, 3_000];
  const timeoutMs = options.timeoutMs ?? 15_000;
  const modelsResponse = await fetchWithRetry(OPENCODE_MODELS_URL, fetcher, retryDelaysMs, timeoutMs);
  const modelsText = await modelsResponse.text();
  let modelsJson: unknown;
  try {
    modelsJson = JSON.parse(modelsText);
  } catch {
    throw new Error("Invalid OpenCode models response: expected JSON");
  }
  const pricingResponse = await fetchWithRetry(OPENCODE_PRICING_URL, fetcher, retryDelaysMs, timeoutMs);
  return { modelsJson, pricingMarkdown: await pricingResponse.text() };
}
