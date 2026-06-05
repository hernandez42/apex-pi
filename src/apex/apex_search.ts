/**
 * apex_search — 5D Memory-native task matching
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Strategy: query the 5D memory store directly for relevant experiences.
 * SKILL.md files are an OPTIONAL materialized cache — the primary store is 5D.
 *
 * 5D dimensions mapped to SKILL relevance:
 *   procedural  → skill/how-to patterns (most relevant for task execution)
 *   semantic    → knowledge and concepts (context)
 *   episodic    → past events (similar situations)
 *   declarative → hard facts (constraints)
 *   working     → current session context
 */

import type { MemoryEngine, MemoryHit } from "../memory/index.ts";
import { type SearchInput } from "../memory/types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskFingerprint {
  intent: string;   // "fix_git_merge_conflict"
  context: string;  // "pilotdeck/src/mcp/*"
  raw: string;      // original user message
}

export interface SkillMatch {
  hit: MemoryHit;          // from 5D search
  dimension: string;      // which 5D dimension matched
  content: string;        // memory content
  importance: number;     // importance = fitness proxy
  accessCount: number;    // usage frequency
}

export interface SearchResult {
  matches: SkillMatch[];
  totalScore: number;     // fused score across all hits
  systemDeltaG: number;   // 5D system health at query time
}

// ─── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 6;
const DIMENSION_WEIGHTS: Record<string, number> = {
  procedural: 0.40,  // highest weight — these ARE skills
  semantic:   0.25,
  episodic:   0.20,
  declarative:0.10,
  working:    0.05,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Query 5D memory for relevant experiences matching a task.
 * Returns ranked SkillMatch[] — SKILL pool quality reflected in importance scores.
 */
export async function apex_search(
  engine: MemoryEngine,
  task: TaskFingerprint,
  options: { topK?: number; systemHealth?: boolean } = {}
): Promise<SearchResult> {
  const topK = options.topK ?? DEFAULT_TOP_K;

  // Build query from task fingerprint
  const query = build_query(task);

  // Run hybrid 5D search
  const hits = await engine.search({
    query,
    topK: topK * 2,  // oversearch, then filter
    expandGraph: true,
  });

  // Score and weight by dimension
  const weighted = hits
    .map(hit => ({
      hit,
      dimension: hit.record.dimension,
      content: hit.record.content,
      importance: hit.record.importance,         // fitness proxy
      accessCount: hit.record.accessCount,       // usage frequency
      weightedScore: hit.score * (DIMENSION_WEIGHTS[hit.record.dimension] ?? 0.1),
    }))
    .filter(h => h.dimension === "procedural" || h.dimension === "semantic")
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, topK);

  const totalScore = weighted.reduce((sum, h) => sum + h.weightedScore, 0);

  // Get system health if requested
  let systemDeltaG = 0;
  if (options.systemHealth) {
    const health = await engine.health();
    systemDeltaG = health.deltaG;
  }

  return {
    matches: weighted,
    totalScore,
    systemDeltaG,
  };
}

/**
 * Build a rich query string from task fingerprint.
 * Combines intent keywords + context for hybrid 5D search.
 */
export function build_query(task: TaskFingerprint): string {
  const parts: string[] = [task.intent];
  if (task.context) parts.push(task.context);
  if (task.raw.length > 20 && task.raw !== task.intent) {
    parts.push(task.raw.slice(0, 200));
  }
  return parts.join(" ");
}

/**
 * Find the single best procedural (skill) match for a task.
 * Returns null if no procedural memory meets the minimum importance threshold.
 */
export async function apex_search_best_skill(
  engine: MemoryEngine,
  task: TaskFingerprint,
  options: { minImportance?: number } = {}
): Promise<SkillMatch | null> {
  const minImportance = options.minImportance ?? 0.3;
  const result = await apex_search(engine, task, { topK: 1 });
  const best = result.matches.find(m => m.importance >= minImportance);
  return best ?? null;
}