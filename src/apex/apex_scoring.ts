/**
 * apex_scoring — 5D-native fitness evaluation
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Fitness is NOT a stored number. It IS the 5D importance field.
 * Scoring is a LIVE query → derives fitness from the 5D system.
 *
 * The fitness formula maps directly onto 5D fields:
 *   importance  ←→ fitness score (0..1)
 *   accessCount ←→ invocation count (usage frequency)
 *   accessedAt ←→ recency (for decay calculation)
 *   deltaG     ←→ system-level health
 *
 * This means apex_evolver never "stores" fitness — it queries 5D.
 */

import type { MemoryEngine, MemoryHit } from "../memory/index.ts";
import type { MemoryRecord } from "../memory/types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  duration_ms: number;
  tool_calls?: string[];
}

export interface FitnessProfile {
  importance: number;       // current importance in 5D (fitness proxy)
  accessCount: number;     // how many times this skill was used
  lastUsed: number;        // epoch ms
  recencyScore: number;    // 0..1, exponential decay with 30d half-life
  consistencyScore: number; // tool call pattern consistency
  systemDeltaG: number;    // 5D system health at scoring time
  overallFitness: number; // weighted combination
}

export interface ScoreBreakdown {
  executionSuccess: boolean;
  profile: FitnessProfile;
  thresholds: {
    active: boolean;    // importance >= 0.6
    reDistill: boolean; // 0.3 <= importance < 0.6
    deprecated: boolean;// importance < 0.3
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const THRESHOLD_ACTIVE = 0.6;
const THRESHOLD_REDISTILL = 0.3;

const DIMENSION_WEIGHTS: Record<string, number> = {
  procedural: 0.40,
  semantic:   0.25,
  episodic:   0.20,
  declarative:0.10,
  working:    0.05,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Score a task execution result and compute fitness.
 * Fitness is derived from 5D fields — not stored separately.
 *
 * @param engine  — the 5D memory engine
 * @param record  — the memory record being scored (from 5D)
 * @param result  — outcome of current execution
 */
export async function apex_scoring(
  engine: MemoryEngine,
  record: MemoryRecord,
  result: ExecutionResult
): Promise<ScoreBreakdown> {
  const now = Date.now();
  const ageMs = now - record.accessedAt;
  const recencyScore = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);

  // Consistency: based on tool call patterns (stored in record.meta)
  const consistencyScore = compute_consistency(record);

  // System health from 5D
  const health = await engine.health();
  const systemDeltaG = health.deltaG;

  // Overall fitness: importance IS the fitness score in 5D
  // Bump importance on success, slight decay on failure
  const importanceDelta = result.success ? 0.05 : -0.1;
  const overallFitness = Math.max(0, Math.min(1, record.importance + importanceDelta));

  return {
    executionSuccess: result.success,
    profile: {
      importance: record.importance,
      accessCount: record.accessCount,
      lastUsed: record.accessedAt,
      recencyScore,
      consistencyScore,
      systemDeltaG,
      overallFitness,
    },
    thresholds: {
      active: overallFitness >= THRESHOLD_ACTIVE,
      reDistill: overallFitness >= THRESHOLD_REDISTILL && overallFitness < THRESHOLD_ACTIVE,
      deprecated: overallFitness < THRESHOLD_REDISTILL,
    },
  };
}

/**
 * Score a set of memory hits for task relevance (used by apex_evolver).
 * Returns aggregate fitness stats across the matched memory pool.
 */
export async function apex_scoring_pool(
  engine: MemoryEngine,
  hits: MemoryHit[]
): Promise<{
  avgImportance: number;
  maxImportance: number;
  systemDeltaG: number;
  poolHealth: "healthy" | "degraded" | "critical";
}> {
  if (hits.length === 0) {
    return { avgImportance: 0, maxImportance: 0, systemDeltaG: -1, poolHealth: "critical" };
  }

  const health = await engine.health();
  const deltaG = health.deltaG;

  const importances = hits.map(h => h.record.importance);
  const avgImportance = importances.reduce((a, b) => a + b, 0) / importances.length;
  const maxImportance = Math.max(...importances);

  let poolHealth: "healthy" | "degraded" | "critical";
  if (deltaG > 0.5 && avgImportance > 0.5) poolHealth = "healthy";
  else if (deltaG > 0 || avgImportance > 0.3) poolHealth = "degraded";
  else poolHealth = "critical";

  return { avgImportance, maxImportance, systemDeltaG: deltaG, poolHealth };
}

// ─── Internal ───────────────────────────────────────────────────────────────

function compute_consistency(record: MemoryRecord): number {
  // Tool call consistency: stored in record.meta as toolCallPattern
  const meta = record.meta as Record<string, unknown> | undefined;
  if (!meta?.toolCallPattern) return 0.5;  // neutral — no data

  const pattern = meta.toolCallPattern as string[];
  if (pattern.length < 2) return 1;  // single use — assume consistent

  // Coefficient of variation on tool count
  const mean = pattern.length;
  const variance = pattern.reduce((sum, count) => sum + Math.pow(count - mean, 2), 0) / pattern.length;
  const cv = Math.sqrt(variance) / Math.max(mean, 1);

  return Math.max(0, Math.min(1, 1 / (1 + cv)));
}

export { THRESHOLD_ACTIVE, THRESHOLD_REDISTILL };