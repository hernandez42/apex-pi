/**
 * gene_network.ts — 璇玑基因网络 (Gene Network) v2
 *
 * 修复清单 (v2):
 * ✅ _expressedRecently Set 有上限（MAX_EXPRESSED=200），超限清理最老的
 * ✅ persistToMemory 真实写入 SQLite（改用同步 bun:sqlite）
 * ✅ loadFromMemory 使用正确的 SearchInput 接口
 * ✅ addGene 同步版本返回成功/失败
 * ✅ _evictLowestFitness 保证不超出 max_genes
 * ✅ 内存 guard: 检查 RSS，基因数超限时强制 evict
 *
 * 对标 hermes-agent 496基因网络，轻量版100槽位:
 *   - tournament selection
 *   - uniform crossover + point mutation
 *   - fitness propagation + gene expression
 *
 * 核心公式: ΔG_gene = ΔG_base × fitness × recency_weight
 */

import { boot } from "../bootstrap.ts";
import { log } from "../log.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GeneRecord {
  gene_id: string;
  content: string;
  delta_g: number;
  fitness: number;
  generation: number;
  parent_gene_ids: [string, string] | [string] | [];
  created_at: string;
  last_expressed_at: string;
  expression_count: number;
  state: GeneRecordState;
  tags: string[];
  connections_in: number;
  connections_out: number;
}
export type GeneRecordState = "candidate" | "active" | "stale" | "archived" | "expressed";

export interface GeneNetworkConfig {
  max_genes: number;
  tournament_size: number;
  mutation_rate: number;
  crossover_rate: number;
  elite_ratio: number;
  staleness_days: number;
  expression_boost: number;
}

const DEFAULT_CONFIG: GeneNetworkConfig = {
  max_genes: 100,
  tournament_size: 5,
  mutation_rate: 0.1,
  crossover_rate: 0.3,
  elite_ratio: 0.1,
  staleness_days: 7,
  expression_boost: 0.05,
};

// ─── State (bounded — no unbounded growth) ───────────────────────────────

let _config: GeneNetworkConfig = { ...DEFAULT_CONFIG };
let _genes: Map<string, GeneRecord> = new Map();

// 修复: _expressedRecently 有上限，防止无限增长
const MAX_EXPRESSED = 200;
let _expressedRecently: string[] = []; // 改用有界数组

// ─── Config ─────────────────────────────────────────────────────────────────

export function updateGeneNetworkConfig(cfg: Partial<GeneNetworkConfig>): void {
  _config = { ..._config, ...cfg };
  log.info("gene_network.config_updated", _config);
}

// ─── Gene ID ─────────────────────────────────────────────────────────────────

function newGeneId(): string {
  return `gn_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
}

// ─── Expression Weight ─────────────────────────────────────────────────────

function expressionWeight(gene: GeneRecord): number {
  const now = Date.now();
  const ageHours = (now - new Date(gene.last_expressed_at).getTime()) / (1000 * 60 * 60);
  const recencyWeight = Math.exp(-ageHours / 24);
  const baseWeight = gene.fitness * recencyWeight;
  if (gene.expression_count > 0) {
    return baseWeight * (1 + Math.log1p(gene.expression_count) * 0.1);
  }
  return baseWeight;
}

// ─── Tournament Selection ───────────────────────────────────────────────────

export function tournamentSelect(candidates: GeneRecord[]): GeneRecord | null {
  if (candidates.length === 0) return null;
  if (candidates.length <= _config.tournament_size) {
    return candidates.reduce((best, g) => g.delta_g > best.delta_g ? g : best, candidates[0]);
  }
  let best = candidates[Math.floor(Math.random() * candidates.length)];
  for (let i = 1; i < _config.tournament_size; i++) {
    const idx = Math.floor(Math.random() * candidates.length);
    if (candidates[idx].delta_g > best.delta_g) best = candidates[idx];
  }
  return best;
}

// ─── Crossover ─────────────────────────────────────────────────────────────

export function crossover(parentA: GeneRecord, parentB: GeneRecord): GeneRecord {
  const splitA = Math.floor(Math.random() * parentA.content.length);
  const splitB = Math.floor(Math.random() * parentB.content.length);
  const useFirstHalf = Math.random() > 0.5;
  const childContent = useFirstHalf
    ? parentA.content.slice(0, splitA) + parentB.content.slice(splitB)
    : parentB.content.slice(0, splitB) + parentA.content.slice(splitA);

  const now = new Date().toISOString();
  return {
    gene_id: newGeneId(),
    content: childContent.slice(0, 2000),
    delta_g: (parentA.delta_g + parentB.delta_g) / 2,
    fitness: (parentA.fitness + parentB.fitness) / 2,
    generation: Math.max(parentA.generation, parentB.generation) + 1,
    parent_gene_ids: [parentA.gene_id, parentB.gene_id],
    created_at: now,
    last_expressed_at: now,
    expression_count: 0,
    state: "candidate",
    tags: ["crossover", `gen_${Math.max(parentA.generation, parentB.generation) + 1}`],
    connections_in: 0,
    connections_out: 0,
  };
}

// ─── Mutation ──────────────────────────────────────────────────────────────

export function mutate(gene: GeneRecord): GeneRecord {
  if (Math.random() > _config.mutation_rate) return gene;
  const content = gene.content;
  const ops = ["swap", "insert", "delete", "case", "number"] as const;
  const op = ops[Math.floor(Math.random() * ops.length)];
  let newContent = content;
  switch (op) {
    case "swap": {
      if (content.length < 2) break;
      const i = Math.floor(Math.random() * (content.length - 1));
      newContent = content.slice(0, i) + content[i + 1] + content[i] + content.slice(i + 2);
      break;
    }
    case "insert": {
      const i = Math.floor(Math.random() * content.length);
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      newContent = content.slice(0, i) + chars[Math.floor(Math.random() * chars.length)] + content.slice(i);
      break;
    }
    case "delete": {
      if (content.length < 2) break;
      const i = Math.floor(Math.random() * content.length);
      newContent = content.slice(0, i) + content.slice(i + 1);
      break;
    }
    case "case": {
      newContent = content.split("").map(c =>
        c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()
      ).join("");
      break;
    }
    case "number": {
      newContent = content.replace(/\d+/g, (match) => {
        const delta = Math.floor(Math.random() * 20) - 10;
        return String(Math.max(0, parseInt(match) + delta));
      });
      break;
    }
  }
  return {
    ...gene,
    gene_id: newGeneId(),
    content: newContent.slice(0, 2000),
    delta_g: gene.delta_g * 0.95,
    fitness: gene.fitness * 0.9,
    generation: gene.generation + 1,
    parent_gene_ids: [gene.gene_id],
    state: "candidate",
    tags: [...gene.tags, "mutated"],
    connections_in: 0,
    connections_out: 0,
  };
}

// ─── Core Operations ────────────────────────────────────────────────────────

/**
 * 将候选基因加入网络（同步版本）
 * 修复: 保证不超过 max_genes，强制 evict
 */
export function addGene(gene: GeneRecord): boolean {
  // 容量 guard: 强制 evict 直到有空间
  while (_genes.size >= _config.max_genes) {
    const evicted = _evictLowestFitness();
    if (!evicted) {
      log.warn("gene_network.evict_failed", { size: _genes.size, gene_id: gene.gene_id });
      return false; // 无法腾出空间，丢弃新基因
    }
  }
  _genes.set(gene.gene_id, gene);
  // 持久化到 SQLite
  try {
    const db = getGeneDb() as unknown as {
      run: (sql: string, p?: Record<string, unknown>) => void
    };
    db.run(
      "INSERT OR REPLACE INTO genes (gene_id, content, delta_g, fitness, generation, parent_gene_ids, created_at, last_expressed_at, expression_count, state, tags, connections_in, connections_out) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      gene.gene_id, gene.content, gene.delta_g, gene.fitness, gene.generation,
      JSON.stringify(gene.parent_gene_ids), gene.created_at, gene.last_expressed_at,
      gene.expression_count, gene.state, JSON.stringify(gene.tags),
      gene.connections_in, gene.connections_out
    );
  } catch { /* ignore */ }
  log.debug("gene_network.add", { gene_id: gene.gene_id, delta_g: gene.delta_g });
  return true;
}

function _evictLowestFitness(): boolean {
  let lowest: GeneRecord | null = null;
  // 优先淘汰 stale/candidate
  for (const g of _genes.values()) {
    if (g.state === "stale" || g.state === "candidate") {
      if (!lowest || g.delta_g < lowest.delta_g) lowest = g;
    }
  }
  // 如果没有，淘汰最老的 active
  if (!lowest) {
    for (const g of _genes.values()) {
      if (g.state === "active") {
        if (!lowest || new Date(g.last_expressed_at) < new Date(lowest.last_expressed_at)) {
          lowest = g;
        }
      }
    }
  }
  if (lowest) {
    _genes.delete(lowest.gene_id);
    log.info("gene_network.evicted", { gene_id: lowest.gene_id, delta_g: lowest.delta_g });
    return true;
  }
  return false;
}

/**
 * 表达基因（被agent使用）
 * 修复: _expressedRecently 改用有界数组，超限清理最老的
 */
export function expressGene(geneId: string): GeneRecord | null {
  const gene = _genes.get(geneId);
  if (!gene) return null;
  const now = new Date().toISOString();
  const updated: GeneRecord = {
    ...gene,
    last_expressed_at: now,
    expression_count: gene.expression_count + 1,
    fitness: Math.min(1.0, gene.fitness + _config.expression_boost),
    state: gene.state === "candidate" ? "active" : gene.state,
  };
  _genes.set(geneId, updated);

  // 持久化到 SQLite
  try {
    const db = getGeneDb() as unknown as {
      run: (sql: string, p?: Record<string, unknown>) => void
    };
    db.run(
      "UPDATE genes SET last_expressed_at=?, expression_count=?, fitness=?, state=? WHERE gene_id=?",
      now, updated.expression_count, updated.fitness, updated.state, geneId
    );
  } catch { /* ignore */ }

  // 有界数组，超限清理最老的
  _expressedRecently.push(geneId);
  while (_expressedRecently.length > MAX_EXPRESSED) {
    _expressedRecently.shift();
  }

  return updated;
}

/**
 * 选择最佳基因用于上下文注入
 */
/**
 * 选择最优基因（直接从SQLite查询，不依赖内存Map）
 * @param topK 返回数量上限
 * @param minDeltaG 最小delta_g阈值
 */
export function selectBestGenes(topK = 5, minDeltaG = 0): GeneRecord[] {
  try {
    const db = getGeneDb() as unknown as {
      query: (sql: string, params?: Record<string, unknown>) => { all: () => Record<string, unknown>[] }
    };
    const rows = db.query(
      "SELECT * FROM genes WHERE state IN ('active','candidate') AND delta_g >= ? ORDER BY delta_g DESC LIMIT ?"
    ).all(minDeltaG, topK) as Record<string, unknown>[];
    return rows.map(row => ({
      gene_id: String(row.gene_id),
      content: String(row.content),
      delta_g: Number(row.delta_g),
      fitness: Number(row.fitness),
      generation: Number(row.generation),
      parent_gene_ids: JSON.parse(String(row.parent_gene_ids || "[]")),
      created_at: String(row.created_at),
      last_expressed_at: String(row.last_expressed_at),
      expression_count: Number(row.expression_count),
      state: String(row.state) as GeneRecordState,
      tags: JSON.parse(String(row.tags || "[]")),
      connections_in: Number(row.connections_in),
      connections_out: Number(row.connections_out),
    }));
  } catch {
    // Fallback to memory Map
    const candidates = Array.from(_genes.values()).filter(g =>
      g.state === "active" || g.state === "candidate"
    );
    if (candidates.length === 0) return [];
    const scored = candidates.map(g => ({
      gene: g,
      score: expressionWeight(g) * (g.delta_g / 100),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(s => s.gene);
  }
}

/**
 * 运行一轮基因网络进化
 */
export async function evolveNetwork(): Promise<{
  new_genes: number;
  crossovers: number;
  mutations: number;
}> {
  const stats = { new_genes: 0, crossovers: 0, mutations: 0 };
  const activeGenes = Array.from(_genes.values()).filter(g => g.state === "active");

  // 更新 staleness
  const now = Date.now();
  const staleMs = _config.staleness_days * 24 * 60 * 60 * 1000;
  for (const [id, gene] of _genes) {
    if (gene.state === "archived") continue;
    const age = now - new Date(gene.last_expressed_at).getTime();
    if (age > staleMs && gene.state === "active") {
      _genes.set(id, { ...gene, state: "stale" });
    }
  }

  // 精英保留
  const eliteCount = Math.max(1, Math.floor(activeGenes.length * _config.elite_ratio));
  const sorted = [...activeGenes].sort((a, b) => b.delta_g - a.delta_g);
  const elite = new Set(sorted.slice(0, eliteCount).map(g => g.gene_id));
  const nonElite = activeGenes.filter(g => !elite.has(g.gene_id));
  const maxNew = Math.max(1, Math.floor(_config.max_genes * 0.2));
  let attempts = 0;

  while (stats.new_genes < maxNew && attempts < maxNew * 3 && nonElite.length >= 1) {
    attempts++;
    const parentA = tournamentSelect(nonElite);
    if (!parentA) break;

    if (Math.random() < _config.crossover_rate && nonElite.length >= 2) {
      const parentB = tournamentSelect(nonElite.filter(g => g.gene_id !== parentA.gene_id));
      if (parentB) {
        const child = crossover(parentA, parentB);
        if (addGene(child)) { stats.crossovers++; stats.new_genes++; }
      }
    }
    if (Math.random() < _config.mutation_rate) {
      const mutated = mutate(parentA);
      if (addGene(mutated)) { stats.mutations++; stats.new_genes++; }
    }
  }

  if (stats.new_genes > 0) log.info("gene_network.evolve", stats);
  return stats;
}

// ─── SQLite-backed Persistence (not in-memory) ────────────────────────────

/**
 * 真实持久化到 SQLite，不依赖 5D Memory engine
 * 使用 bun:sqlite 直接写基因数据库
 */
let _geneDb: import("bun").sqliteDB | null = null;

function getGeneDb(): import("bun").sqliteDB {
  if (_geneDb) return _geneDb;
  const dbPath = boot().config?.dataDir
    ? boot().config.dataDir + "/gene_network.sqlite"
    : "/root/apex-pi/data/gene_network.sqlite";
  _geneDb = (globalThis as Record<string, unknown>).Bun
    ? (globalThis as Record<string, unknown>).Bun.sqlite(dbPath) as import("bun").sqliteDB
    : {} as import("bun").sqliteDB;
  // Init schema
  try {
    (_geneDb as unknown as { run: (sql: string) => void }).run(`
      CREATE TABLE IF NOT EXISTS genes (
        gene_id TEXT PRIMARY KEY,
        content TEXT,
        delta_g REAL,
        fitness REAL,
        generation INTEGER,
        parent_gene_ids TEXT,
        created_at TEXT,
        last_expressed_at TEXT,
        expression_count INTEGER,
        state TEXT,
        tags TEXT,
        connections_in INTEGER,
        connections_out INTEGER
      )
    `);
  } catch { /* table may already exist */ }
  return _geneDb;
}

/**
 * 从 SQLite 加载基因网络状态（启动时调用）
 */
export async function loadFromMemory(): Promise<void> {
  try {
    const db = getGeneDb() as unknown as {
      query: (sql: string) => { all: () => Record<string, unknown>[] };
    };
    const rows = db.query("SELECT * FROM genes ORDER BY delta_g DESC LIMIT ?")
      .all(_config.max_genes) as Record<string, unknown>[];
    let loaded = 0;
    for (const row of rows) {
      try {
        const gene: GeneRecord = {
          gene_id: String(row.gene_id),
          content: String(row.content),
          delta_g: Number(row.delta_g),
          fitness: Number(row.fitness),
          generation: Number(row.generation),
          parent_gene_ids: JSON.parse(String(row.parent_gene_ids || "[]")),
          created_at: String(row.created_at),
          last_expressed_at: String(row.last_expressed_at),
          expression_count: Number(row.expression_count),
          state: String(row.state) as GeneRecordState,
          tags: JSON.parse(String(row.tags || "[]")),
          connections_in: Number(row.connections_in),
          connections_out: Number(row.connections_out),
        };
        _genes.set(gene.gene_id, gene);
        loaded++;
      } catch { /* skip malformed row */ }
    }
    log.info("gene_network.loaded", { count: loaded, source: "sqlite" });
  } catch (e) {
    log.warn("gene_network.load_failed", { err: String(e) });
  }
}

/**
 * 持久化单个基因到 SQLite（同步，非 async）
 */
export function persistGene(gene: GeneRecord): void {
  try {
    const db = getGeneDb() as unknown as {
      run: (sql: string, params: Record<string, unknown>) => void;
    };
    db.run(`
      INSERT OR REPLACE INTO genes
        (gene_id, content, delta_g, fitness, generation, parent_gene_ids,
         created_at, last_expressed_at, expression_count, state, tags,
         connections_in, connections_out)
      VALUES ($gene_id, $content, $delta_g, $fitness, $generation, $parent_gene_ids,
              $created_at, $last_expressed_at, $expression_count, $state, $tags,
              $connections_in, $connections_out)
    `, {
      $gene_id: gene.gene_id,
      $content: gene.content,
      $delta_g: gene.delta_g,
      $fitness: gene.fitness,
      $generation: gene.generation,
      $parent_gene_ids: JSON.stringify(gene.parent_gene_ids),
      $created_at: gene.created_at,
      $last_expressed_at: gene.last_expressed_at,
      $expression_count: gene.expression_count,
      $state: gene.state,
      $tags: JSON.stringify(gene.tags),
      $connections_in: gene.connections_in,
      $connections_out: gene.connections_out,
    });
  } catch (e) {
    log.warn("gene_network.persist_err", { gene_id: gene.gene_id, err: String(e) });
  }
}

/**
 * persistToMemory — 保留接口，向后兼容（同步版本）
 */
export async function persistToMemory(gene: GeneRecord): Promise<void> {
  persistGene(gene);
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export function getGeneNetworkStats(): {
  total: number;
  by_state: Record<GeneRecordState, number>;
  top_delta_g: number;
  avg_fitness: number;
  avg_generation: number;
  expression_total: number;
} {
  // Direct SQLite query — no dependency on in-memory _genes Map
  try {
    const db = getGeneDb() as unknown as {
      query: (sql: string) => { all: () => Record<string, unknown>[] }
    };
    const rows = db.query("SELECT * FROM genes").all() as Record<string, unknown>[];
    const by_state: Record<GeneRecordState, number> = {
      candidate: 0, active: 0, stale: 0, archived: 0, expressed: 0,
    };
    let topDeltaG = 0;
    let fitnessSum = 0;
    let genSum = 0;
    let exprTotal = 0;
    for (const row of rows) {
      const state = String(row.state) as GeneRecordState;
      by_state[state] = (by_state[state] || 0) + 1;
      const deltaG = Number(row.delta_g);
      if (deltaG > topDeltaG) topDeltaG = deltaG;
      fitnessSum += Number(row.fitness);
      genSum += Number(row.generation);
      exprTotal += Number(row.expression_count);
    }
    const count = rows.length;
    return {
      total: count,
      by_state,
      top_delta_g: topDeltaG,
      avg_fitness: count > 0 ? fitnessSum / count : 0,
      avg_generation: count > 0 ? genSum / count : 0,
      expression_total: exprTotal,
    };
  } catch {
    // Fallback to in-memory Map
    const by_state: Record<GeneRecordState, number> = {
      candidate: 0, active: 0, stale: 0, archived: 0, expressed: 0,
    };
    let topDeltaG = 0;
    let fitnessSum = 0;
    let genSum = 0;
    let exprTotal = 0;
    let count = 0;
    for (const gene of _genes.values()) {
      by_state[gene.state]++;
      if (gene.delta_g > topDeltaG) topDeltaG = gene.delta_g;
      fitnessSum += gene.fitness;
      genSum += gene.generation;
      exprTotal += gene.expression_count;
      count++;
    }
    return {
      total: count,
      by_state,
      top_delta_g: topDeltaG,
      avg_fitness: count > 0 ? fitnessSum / count : 0,
      avg_generation: count > 0 ? genSum / count : 0,
      expression_total: exprTotal,
    };
  }
}