```ts
/* src/evo/curator.ts */

export type Gene = {
  gene_id: string;
  content?: string | null;
  delta_g?: number | null;
  fitness?: number | null;
  generation?: number | null;
  parent_gene_ids?: string | null;
  created_at?: string | null;
  last_expressed_at?: string | null;
  expression_count?: number | null;
  state?: string | null;
  tags?: string | string[] | null;
  connections_in?: number | null;
  connections_out?: number | null;

  /**
   * Optional precomputed values. Not part of the DB schema, but accepted by the
   * curator when callers already have these metrics.
   */
  novelty?: number | null;
  complexity?: number | null;
  age?: number | null;

  [key: string]: unknown;
};

export type CuratedGene = Gene & {
  rank: number;
  score: number;
  components: {
    fitness: number;
    novelty: number;
    complexity: number;
    age: number;
  };
  raw: {
    fitness: number;
    novelty: number;
    complexity: number;
    age: number;
  };
  parsedTags: string[];
};

export type CuratorWeights = {
  fitness?: number;
  novelty?: number;
  complexity?: number;
  age?: number;
};

export type DiversityConfig =
  | boolean
  | {
      enabled?: boolean;
      maxPerTag?: number;
      includeUntagged?: boolean;
      untaggedTag?: string;
    };

export type CuratorConfig = {
  maxSelect: number;
  weights?: CuratorWeights;

  /**
   * Optional diversity filtering.
   *
   * Examples:
   * - diversity: true, maxPerTag: 2
   * - diversity: { enabled: true, maxPerTag: 2 }
   */
  diversity?: DiversityConfig;
  maxPerTag?: number;

  /**
   * Reference time for age calculation from created_at.
   * Defaults to Date.now().
   */
  now?: Date | string | number;

  /**
   * If true, genes with invalid/empty ids are ignored.
   * Defaults to true.
   */
  requireId?: boolean;
};

type AnnotatedGene = CuratedGene & {
  __index: number;
};

const DEFAULT_WEIGHTS: Required<CuratorWeights> = {
  fitness: 1,
  novelty: 0.25,
  complexity: -0.05,
  age: 0.1,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function safeInteger(value: unknown, fallback = 0): number {
  const n = safeNumber(value, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function getGeneId(gene: Gene): string {
  return String(gene.gene_id ?? "").trim();
}

function compareStringAsc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function parseTags(tags: Gene["tags"]): string[] {
  if (Array.isArray(tags)) {
    return normalizeTags(tags);
  }

  if (typeof tags !== "string") return [];

  const trimmed = tags.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return normalizeTags(parsed);
    }
  } catch {
    // Fall through to delimiter parsing.
  }

  return normalizeTags(trimmed.split(/[,\s;|]+/g));
}

function normalizeTags(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const tag = String(value ?? "").trim();
    if (!tag) continue;
    if (seen.has(tag)) continue;

    seen.add(tag);
    out.push(tag);
  }

  return out;
}

function parseTimeMs(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }

  return null;
}

function getNowMs(config: CuratorConfig): number {
  const parsed = parseTimeMs(config.now);
  return parsed ?? Date.now();
}

function rawFitness(gene: Gene): number {
  const fitness = safeNumber(gene.fitness, NaN);
  if (Number.isFinite(fitness)) return fitness;

  return safeNumber(gene.delta_g, 0);
}

function rawNovelty(gene: Gene): number {
  const explicit = safeNumber(gene.novelty, NaN);
  if (Number.isFinite(explicit)) return explicit;

  const expressionCount = Math.max(0, safeInteger(gene.expression_count, 0));

  return 1 / (1 + expressionCount);
}

function rawComplexity(gene: Gene): number {
  const explicit = safeNumber(gene.complexity, NaN);
  if (Number.isFinite(explicit)) return explicit;

  const connectionsIn = Math.max(0, safeInteger(gene.connections_in, 0));
  const connectionsOut = Math.max(0, safeInteger(gene.connections_out, 0));
  const contentLength =
    typeof gene.content === "string" ? Math.max(0, gene.content.length) : 0;

  return connectionsIn + connectionsOut + Math.log1p(contentLength);
}

function rawAge(gene: Gene, nowMs: number): number {
  const explicit = safeNumber(gene.age, NaN);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);

  const createdAtMs = parseTimeMs(gene.created_at);
  if (createdAtMs !== null) {
    return Math.max(0, (nowMs - createdAtMs) / DAY_MS);
  }

  return Math.max(0, safeInteger(gene.generation, 0));
}

function normalizeSeries(values: number[]): number[] {
  if (values.length === 0) return [];

  let min = Infinity;
  let max = -Infinity;

  for (const value of values) {
    const n = safeNumber(value, 0);
    if (n < min) min = n;
    if (n > max) max = n;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return values.map(() => 0);
  }

  if (max === min) {
    const neutral = max === 0 ? 0 : 0.5;
    return values.map(() => neutral);
  }

  return values.map((value) => clamp01((safeNumber(value, 0) - min) / (max - min)));
}

function getWeights(config: CuratorConfig): Required<CuratorWeights> {
  return {
    fitness: safeNumber(config.weights?.fitness, DEFAULT_WEIGHTS.fitness),
    novelty: safeNumber(config.weights?.novelty, DEFAULT_WEIGHTS.novelty),
    complexity: safeNumber(config.weights?.complexity, DEFAULT_WEIGHTS.complexity),
    age: safeNumber(config.weights?.age, DEFAULT_WEIGHTS.age),
  };
}

function getDiversityMaxPerTag(config: CuratorConfig): number | null {
  if (!config.diversity) return null;

  if (typeof config.diversity === "boolean") {
    if (!config.diversity) return null;
    const max = safeInteger(config.maxPerTag, 1);
    return max > 0 ? max : null;
  }

  if (config.diversity.enabled === false) return null;

  const max = safeInteger(config.diversity.maxPerTag ?? config.maxPerTag, 1);
  return max > 0 ? max : null;
}

function shouldIncludeUntagged(config: CuratorConfig): boolean {
  if (!config.diversity || typeof config.diversity === "boolean") return false;
  return config.diversity.includeUntagged === true;
}

function getUntaggedTag(config: CuratorConfig): string {
  if (!config.diversity || typeof config.diversity === "boolean") {
    return "__untagged__";
  }

  return String(config.diversity.untaggedTag ?? "__untagged__");
}

function passesDiversityFilter(
  gene: AnnotatedGene,
  tagCounts: Map<string, number>,
  maxPerTag: number,
  config: CuratorConfig,
): boolean {
  const tags =
    gene.parsedTags.length > 0
      ? gene.parsedTags
      : shouldIncludeUntagged(config)
        ? [getUntaggedTag(config)]
        : [];

  if (tags.length === 0) return true;

  for (const tag of tags) {
    if ((tagCounts.get(tag) ?? 0) >= maxPerTag) {
      return false;
    }
  }

  for (const tag of tags) {
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  return true;
}

function stableScoreComparator(a: AnnotatedGene, b: AnnotatedGene): number {
  const scoreDiff = safeNumber(b.score) - safeNumber(a.score);
  if (scoreDiff !== 0) return scoreDiff;

  const fitnessDiff = safeNumber(b.components.fitness) - safeNumber(a.components.fitness);
  if (fitnessDiff !== 0) return fitnessDiff;

  const noveltyDiff = safeNumber(b.components.novelty) - safeNumber(a.components.novelty);
  if (noveltyDiff !== 0) return noveltyDiff;

  const idDiff = compareStringAsc(getGeneId(a), getGeneId(b));
  if (idDiff !== 0) return idDiff;

  return a.__index - b.__index;
}

/**
 * Required stable ordering for final curated output:
 * fitness desc, novelty desc, id asc.
 */
function stableFinalComparator(a: AnnotatedGene, b: AnnotatedGene): number {
  const fitnessDiff = safeNumber(b.raw.fitness) - safeNumber(a.raw.fitness);
  if (fitnessDiff !== 0) return fitnessDiff;

  const noveltyDiff = safeNumber(b.raw.novelty) - safeNumber(a.raw.novelty);
  if (noveltyDiff !== 0) return noveltyDiff;

  const idDiff = compareStringAsc(getGeneId(a), getGeneId(b));
  if (idDiff !== 0) return idDiff;

  return a.__index - b.__index;
}

export function selectGenes(
  candidates: readonly Gene[],
  config: CuratorConfig,
): CuratedGene[] {
  const maxSelect = Math.max(0, safeInteger(config.maxSelect, 0));
  if (!Array.isArray(candidates) || candidates.length === 0 || maxSelect === 0) {
    return [];
  }

  const requireId = config.requireId !== false;
  const nowMs = getNowMs(config);
  const weights = getWeights(config);

  const valid = candidates
    .map((gene, index) => ({ gene, index }))
    .filter(({ gene }) => {
      if (!gene || typeof gene !== "object") return false;
      if (!requireId) return true;
      return getGeneId(gene).length > 0;
    });

  if (valid.length === 0) return [];

  const rawFitnessValues = valid.map(({ gene }) => rawFitness(gene));
  const rawNoveltyValues = valid.map(({ gene }) => rawNovelty(gene));
  const rawComplexityValues = valid.map(({ gene }) => rawComplexity(gene));
  const rawAgeValues = valid.map(({ gene }) => rawAge(gene, nowMs));

  const fitnessNorm = normalizeSeries(rawFitnessValues);
  const noveltyNorm = normalizeSeries(rawNoveltyValues);
  const complexityNorm = normalizeSeries(rawComplexityValues);
  const ageNorm = normalizeSeries(rawAgeValues);

  const annotated: AnnotatedGene[] = valid.map(({ gene, index }, i) => {
    const components = {
      fitness: safeNumber(fitnessNorm[i], 0),
      novelty: safeNumber(noveltyNorm[i], 0),
      complexity: safeNumber(complexityNorm[i], 0),
      age: safeNumber(ageNorm[i], 0),
    };

    const raw = {
      fitness: safeNumber(rawFitnessValues[i], 0),
      novelty: safeNumber(rawNoveltyValues[i], 0),
      complexity: safeNumber(rawComplexityValues[i], 0),
      age: safeNumber(rawAgeValues[i], 0),
    };

    const score = safeNumber(
      components.fitness * weights.fitness +
        components.novelty * weights.novelty +
        components.complexity * weights.complexity +
        components.age * weights.age,
      0,
    );

    return {
      ...gene,
      rank: 0,
      score,
      components,
      raw,
      parsedTags: parseTags(gene.tags),
      __index: index,
    };
  });

  const ranked = annotated.slice().sort(stableScoreComparator);

  const maxPerTag = getDiversityMaxPerTag(config);
  const selected: AnnotatedGene[] = [];

  if (maxPerTag === null) {
    selected.push(...ranked.slice(0, maxSelect));
  } else {
    const tagCounts = new Map<string, number>();

    for (const gene of ranked) {
      if (selected.length >= maxSelect) break;

      if (passesDiversityFilter(gene, tagCounts, maxPerTag, config)) {
        selected.push(gene);
      }
    }
  }

  return selected
    .slice()
    .sort(stableFinalComparator)
    .map((gene, index) => {
      const { __index, ...clean } = gene;
      return {
        ...clean,
        rank: index + 1,
        score: safeNumber(clean.score, 0),
      };
    });
}

/*
Unit test example with Vitest:

import { describe, expect, it } from "vitest";
import { selectGenes, Gene } from "./curator";

describe("selectGenes", () => {
  it("selects at most maxSelect genes and guards NaN/Infinity", () => {
    const genes: Gene[] = [
      { gene_id: "b", content: "x", fitness: Infinity, generation: 1, tags: "core", expression_count: 0 },
      { gene_id: "a", content: "xx", fitness: 1, generation: 2, tags: "core", expression_count: 1 },
      { gene_id: "c", content: "xxx", fitness: NaN, generation: 3, tags: "edge", expression_count: 2 },
    ];

    const selected = selectGenes(genes, {
      maxSelect: 2,
      weights: { fitness: 1, novelty: 0.2, complexity: -0.1, age: 0.1 },
    });

    expect(selected).toHaveLength(2);
    expect(selected.every((g) => Number.isFinite(g.score))).toBe(true);
  });

  it("uses stable final ordering: fitness desc, novelty desc, id asc", () => {
    const genes: Gene[] = [
      { gene_id: "b", fitness: 1, novelty: 0.5, tags: "x" },
      { gene_id: "a", fitness: 1, novelty: 0.5, tags: "x" },
      { gene_id: "c", fitness: 2, novelty: 0.1, tags: "y" },
    ];

    const selected = selectGenes(genes, {
      maxSelect: 3,
      weights: { fitness: 1, novelty: 1, complexity: 0, age: 0 },
    });

    expect(selected.map((g) => g.gene_id)).toEqual(["c", "a", "b"]);
  });

  it("applies diversity filter: same tag at most N genes", () => {
    const genes: Gene[] = [
      { gene_id: "a", fitness: 10, tags: "core" },
      { gene_id: "b", fitness: 9, tags: "core" },
      { gene_id: "c", fitness: 8, tags: "core" },
      { gene_id: "d", fitness: 7, tags: "edge" },
    ];

    const selected = selectGenes(genes, {
      maxSelect: 4,
      diversity: { enabled: true, maxPerTag: 2 },
    });

    expect(selected.filter((g) => g.parsedTags.includes("core"))).toHaveLength(2);
  });
});
*/
```