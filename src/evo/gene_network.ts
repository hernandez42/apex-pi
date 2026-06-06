/**
 * gene_network.ts — 璇玑基因网络 (Gene Network)
 *
 * 对标 hermes-agent 496基因网络，apex-pi 的轻量版：
 *   - 100个基因槽位（服务器内存限制）
 *   - tournament selection（竞争选择）
 *   - uniform crossover（均匀交叉）
 *   - point mutation（点突变）
 *   - fitness propagation（适应度传播）
 *   - gene expression（基因→行为）
 *
 * 核心公式: ΔG_gene = ΔG_base × fitness × recency_weight
 *
 * 集成点:
 *   - background-review.ts: fork review 后生成候选基因
 *   - moss.ts: sparkRippleTick 驱动基因网络评估
 *   - agent.ts: recallGenes() → systemPrompt 注入（基因表达）
 */

import { getMemoryEngine } from "../memory/index.ts";
import { boot } from "../bootstrap.ts";
import { log } from "../log.ts";
import type { Gene } from "./moss.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GeneRecord {
  gene_id: string;
  content: string;               // 基因内容（可执行的代码片段或策略描述）
  delta_g: number;               // ΔG贡献
  fitness: number;               // 适应度 0..1
  generation: number;            // 代数
  parent_gene_ids: [string, string] | [string] | []; // 亲本基因（用于交叉）
  created_at: string;
  last_expressed_at: string;     // 上次被表达（用于recency权重）
  expression_count: number;       // 被表达次数
  state: GeneRecordState;
  tags: string[];
  // 网络结构
  connections_in: number;        // 被引用次数
  connections_out: number;       // 引用其他基因的次数
}

export type GeneRecordState = "candidate" | "active" | "stale" | "archived" | "expressed";

export interface GeneNetworkConfig {
  max_genes: number;             // 最大基因数 (default: 100)
  tournament_size: number;       // 锦标赛规模 (default: 5)
  mutation_rate: number;         // 突变率 (default: 0.1)
  crossover_rate: number;        // 交叉率 (default: 0.3)
  elite_ratio: number;           // 精英保留比例 (default: 0.1)
  staleness_days: number;        // 多少天不表达 = stale (default: 7)
  expression_boost: number;      // 被表达后fitness提升 (default: 0.05)
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

// ─── State ───────────────────────────────────────────────────────────────────

let _config: GeneNetworkConfig = { ...DEFAULT_CONFIG };
let _genes: Map<string, GeneRecord> = new Map();
let _expressedRecently: Set<string> = new Set(); // 最近表达的基因ID

// ─── Config ─────────────────────────────────────────────────────────────────

export function updateGeneNetworkConfig(cfg: Partial<GeneNetworkConfig>): void {
  _config = { ..._config, ...cfg };
  log.info("gene_network.config_updated", _config);
}

// ─── Gene ID ─────────────────────────────────────────────────────────────────

function newGeneId(): string {
  return `gn_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
}

// ─── Gene Expression Weight ─────────────────────────────────────────────────

/**
 * 计算基因的表达权重 = fitness × recency_weight × expression_boost
 *
 * recency_weight: 最近被表达的基因权重更高（指数衰减）
 * half_life: 1小时半衰期
 */
function expressionWeight(gene: GeneRecord): number {
  const now = Date.now();
  const lastExpressed = new Date(gene.last_expressed_at).getTime();
  const ageHours = (now - lastExpressed) / (1000 * 60 * 60);
  const recencyWeight = Math.exp(-ageHours / 24); // 24小时半衰期

  const baseWeight = gene.fitness * recencyWeight;

  // 被表达过的基因获得额外boost
  if (gene.expression_count > 0) {
    return baseWeight * (1 + Math.log1p(gene.expression_count) * 0.1);
  }

  return baseWeight;
}

// ─── Tournament Selection ───────────────────────────────────────────────────

/**
 * 锦标赛选择：从候选基因中选最优
 * 1. 随机选N个基因
 * 2. 返回ΔG最高的
 */
export function tournamentSelect(candidates: GeneRecord[]): GeneRecord | null {
  if (candidates.length === 0) return null;
  if (candidates.length <= _config.tournament_size) {
    return candidates.reduce((best, g) => g.delta_g > best.delta_g ? g : best, candidates[0]);
  }

  let best: GeneRecord = candidates[Math.floor(Math.random() * candidates.length)];
  for (let i = 1; i < _config.tournament_size; i++) {
    const idx = Math.floor(Math.random() * candidates.length);
    if (candidates[idx].delta_g > best.delta_g) {
      best = candidates[idx];
    }
  }
  return best;
}

// ─── Crossover ─────────────────────────────────────────────────────────────

/**
 * 均匀交叉：两个亲本生成一个子本
 * 子本内容 = 随机混合亲本内容片段
 */
export function crossover(parentA: GeneRecord, parentB: GeneRecord): GeneRecord {
  const contents = [parentA.content, parentB.content];
  const splitA = Math.floor(Math.random() * parentA.content.length);
  const splitB = Math.floor(Math.random() * parentB.content.length);

  // 随机选择交叉方式
  const useFirstHalf = Math.random() > 0.5;
  const childContent = useFirstHalf
    ? parentA.content.slice(0, splitA) + parentB.content.slice(splitB)
    : parentB.content.slice(0, splitB) + parentA.content.slice(splitA);

  const childDeltaG = (parentA.delta_g + parentB.delta_g) / 2;
  const childFitness = (parentA.fitness + parentB.fitness) / 2;

  const now = new Date().toISOString();
  const child: GeneRecord = {
    gene_id: newGeneId(),
    content: childContent.slice(0, 2000), // 限制长度
    delta_g: childDeltaG,
    fitness: childFitness,
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

  return child;
}

// ─── Mutation ──────────────────────────────────────────────────────────────

/**
 * 点突变：对一个基因的content做小幅修改
 * 策略：随机替换、插入、删除字符
 */
export function mutate(gene: GeneRecord): GeneRecord {
  if (Math.random() > _config.mutation_rate) return gene;

  const content = gene.content;
  const ops = ["swap", "insert", "delete", "case", "number"];
  const op = ops[Math.floor(Math.random() * ops.length)];

  let newContent = content;
  switch (op) {
    case "swap": {
      // 随机交换两个相邻字符
      if (content.length < 2) break;
      const i = Math.floor(Math.random() * (content.length - 1));
      newContent = content.slice(0, i) + content[i + 1] + content[i] + content.slice(i + 2);
      break;
    }
    case "insert": {
      // 插入随机字符
      const i = Math.floor(Math.random() * content.length);
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const c = chars[Math.floor(Math.random() * chars.length)];
      newContent = content.slice(0, i) + c + content.slice(i);
      break;
    }
    case "delete": {
      // 删除随机字符
      if (content.length < 2) break;
      const i = Math.floor(Math.random() * content.length);
      newContent = content.slice(0, i) + content.slice(i + 1);
      break;
    }
    case "case": {
      // 大小写翻转
      newContent = content.split("").map(c =>
        c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()
      ).join("");
      break;
    }
    case "number": {
      // 数字微调
      newContent = content.replace(/\d+/g, (match) => {
        const delta = Math.floor(Math.random() * 20) - 10;
        const num = parseInt(match) + delta;
        return String(Math.max(0, num));
      });
      break;
    }
  }

  return {
    ...gene,
    gene_id: newGeneId(),
    content: newContent.slice(0, 2000),
    delta_g: gene.delta_g * 0.95, // 突变通常降低ΔG
    fitness: gene.fitness * 0.9,
    generation: gene.generation + 1,
    parent_gene_ids: [gene.gene_id],
    state: "candidate",
    tags: [...gene.tags, "mutated"],
  };
}

// ─── Gene Network Operations ────────────────────────────────────────────────

/**
 * 将候选基因加入网络
 */
export function addGene(gene: GeneRecord): void {
  // 容量检查：淘汰最低ΔG的stale基因
  if (_genes.size >= _config.max_genes) {
    _evictLowestFitness();
  }

  _genes.set(gene.gene_id, gene);
  log.debug("gene_network.add", { gene_id: gene.gene_id, delta_g: gene.delta_g });
}

function _evictLowestFitness(): void {
  let lowest: GeneRecord | null = null;
  for (const g of _genes.values()) {
    if (g.state === "stale" || g.state === "candidate") {
      if (!lowest || g.delta_g < lowest.delta_g) lowest = g;
    }
  }
  // 如果没有stale/candidate，淘汰最老的active基因
  if (!lowest) {
    let oldest: GeneRecord | null = null;
    for (const g of _genes.values()) {
      if (g.state === "active") {
        if (!oldest || new Date(g.last_expressed_at) < new Date(oldest.last_expressed_at)) {
          oldest = g;
        }
      }
    }
    lowest = oldest;
  }
  if (lowest) {
    _genes.delete(lowest.gene_id);
    log.info("gene_network.evicted", { gene_id: lowest.gene_id, delta_g: lowest.delta_g });
  }
}

/**
 * 表达基因（被agent使用）
 * 表达后：expression_count++，last_expressed_at更新，fitness微调
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
  _expressedRecently.add(geneId);

  // 清理过期
  setTimeout(() => _expressedRecently.delete(geneId), 5 * 60 * 1000);

  return updated;
}

/**
 * 从网络中选择最佳基因（用于上下文注入）
 * 使用tournament selection + expression weight
 */
export function selectBestGenes(query: string, topK = 5): GeneRecord[] {
  const candidates = Array.from(_genes.values()).filter(g =>
    g.state === "active" || g.state === "candidate"
  );

  if (candidates.length === 0) return [];

  // 计算每个基因的综合分数
  const scored = candidates.map(g => ({
    gene: g,
    score: expressionWeight(g) * (g.delta_g / 100),
  }));

  // 按分数排序
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(s => s.gene);
}

/**
 * 运行一轮基因网络进化
 *   1. 锦标赛选择父母
 *   2. 概率交叉生成子基因
 *   3. 概率突变
 *   4. 更新状态（stale/active/archive）
 */
export async function evolveNetwork(): Promise<{
  new_genes: number;
  crossovers: number;
  mutations: number;
  evictions: number;
}> {
  const stats = { new_genes: 0, crossovers: 0, mutations: 0, evictions: 0 };
  const activeGenes = Array.from(_genes.values()).filter(g => g.state === "active");

  // 更新staleness
  const now = Date.now();
  const staleMs = _config.staleness_days * 24 * 60 * 60 * 1000;
  for (const gene of _genes.values()) {
    if (gene.state === "archived") continue;
    const age = now - new Date(gene.last_expressed_at).getTime();
    if (age > staleMs && gene.state === "active") {
      _genes.set(gene.gene_id, { ...gene, state: "stale" });
    }
  }

  // 精英保留：top 10% 不参与变异
  const eliteCount = Math.max(1, Math.floor(activeGenes.length * _config.elite_ratio));
  const sorted = [...activeGenes].sort((a, b) => b.delta_g - a.delta_g);
  const elite = new Set(sorted.slice(0, eliteCount).map(g => g.gene_id));
  const nonElite = activeGenes.filter(g => !elite.has(g.gene_id));

  // 生成新基因：最多生成 max_genes * 0.2 个
  const maxNew = Math.max(1, Math.floor(_config.max_genes * 0.2));
  let attempts = 0;

  while (stats.new_genes < maxNew && attempts < maxNew * 3 && nonElite.length >= 1) {
    attempts++;
    const parentA = tournamentSelect(nonElite);
    if (!parentA) break;

    // 概率交叉
    if (Math.random() < _config.crossover_rate && nonElite.length >= 2) {
      const parentB = tournamentSelect(nonElite.filter(g => g.gene_id !== parentA.gene_id));
      if (parentB) {
        const child = crossover(parentA, parentB);
        addGene(child);
        stats.crossovers++;
        stats.new_genes++;
      }
    }

    // 概率突变
    if (Math.random() < _config.mutation_rate) {
      const mutated = mutate(parentA);
      addGene(mutated);
      stats.mutations++;
      stats.new_genes++;
    }
  }

  if (stats.new_genes > 0 || stats.crossovers > 0 || stats.mutations > 0) {
    log.info("gene_network.evolve", stats);
  }

  return stats;
}

// ─── 从5D Memory加载基因网络 ──────────────────────────────────────────────

/**
 * 从5D Memory恢复基因网络状态
 * 每次启动时调用
 */
export async function loadFromMemory(): Promise<void> {
  try {
    const engine = getMemoryEngine(boot().store);
    const results = await engine.search({ query: "gene", topK: _config.max_genes });

    let loaded = 0;
    for (const hit of results) {
      if (!hit.record.tags.includes("gene")) continue;
      try {
        const parsed = JSON.parse(hit.record.content);
        if (!parsed.gene_id || !parsed.content) continue;

        const gene: GeneRecord = {
          gene_id: parsed.gene_id,
          content: parsed.content,
          delta_g: parsed.delta_g ?? 0,
          fitness: parsed.fitness ?? 0.5,
          generation: parsed.generation ?? 0,
          parent_gene_ids: parsed.parent_gene_ids ?? [],
          created_at: parsed.created_at ?? hit.record.createdAt,
          last_expressed_at: parsed.last_expressed_at ?? hit.record.createdAt,
          expression_count: parsed.expression_count ?? 0,
          state: parsed.state ?? "candidate",
          tags: parsed.tags ?? hit.record.tags,
          connections_in: parsed.connections_in ?? 0,
          connections_out: parsed.connections_out ?? 0,
        };

        _genes.set(gene.gene_id, gene);
        loaded++;
      } catch { /* skip malformed */ }
    }

    log.info("gene_network.loaded", { count: loaded });
  } catch (e) {
    log.warn("gene_network.load_failed", { err: String(e) });
  }
}

// ─── 持久化到5D Memory ─────────────────────────────────────────────────────

/**
 * 将基因网络状态持久化到5D Memory
 * 每当基因状态变化时调用
 */
export async function persistToMemory(gene: GeneRecord): Promise<void> {
  try {
    const engine = getMemoryEngine(boot().store);
    await engine.ingest({
      dimension: "episodic",
      content: JSON.stringify(gene),
      tags: ["gene", "gene_network", `state_${gene.state}`, `gen_${gene.generation}`],
      importance: Math.min(1.0, gene.delta_g / 100),
      meta: {
        gene_id: gene.gene_id,
        delta_g: gene.delta_g,
        fitness: gene.fitness,
        generation: gene.generation,
        state: gene.state,
      },
    });
  } catch (e) {
    log.warn("gene_network.persist_failed", { err: String(e) });
  }
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