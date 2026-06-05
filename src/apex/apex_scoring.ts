/**
 * apex_scoring — Execution result → fitness score
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Fitness formula:
 *   fitness = success_rate × invocations^0.3 × recency_decay
 *
 * Thresholds:
 *   >= 0.6  → active (keep)
 *   0.3~0.6 → re_distill (rewrite)
 *   < 0.3   → deprecated (淘汰)
 */

import { differenceInHours } from "date-fns";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  duration_ms: number;
  tool_calls?: string[];    // tools used during execution
  context_snapshot?: string; // relevant context at execution time
}

export interface ScoreBreakdown {
  raw_score: number;         // success → 1, failure → 0
  recency_score: number;     // time decay factor
  consistency_score: number; // tool call consistency across runs
  final_fitness: number;     // weighted combination
  thresholds: {
    active: boolean;
    re_distill: boolean;
    deprecated: boolean;
  };
}

export interface SkillStats {
  invocation_count: number;
  success_count: number;
  total_duration_ms: number;
  last_used: string;        // ISO 8601
  recent_results: ExecutionResult[];
}

// ─── Config ─────────────────────────────────────────────────────────────────

const RECENCY_HALF_LIFE_HOURS = 72;    // 72h half-life → score halves every 3 days
const INVOCATION_SLOWDOWN = 0.3;       // exponent on invocation count
const CONSISTENCY_WEIGHT = 0.1;        // weight for tool call consistency
const SUCCESS_WEIGHT = 0.6;           // weight for raw success rate
const RECENCY_WEIGHT = 0.3;           // weight for recency decay

export const THRESHOLD_ACTIVE = 0.6;
export const THRESHOLD_REDISTILL = 0.3;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Score an execution result and compute the new fitness for a SKILL.
 *
 * @param result      — outcome of the current task execution
 * @param stats       — historical stats for this SKILL
 * @param last_used   — ISO timestamp of last invocation
 */
export function apex_scoring(
  result: ExecutionResult,
  stats: SkillStats,
  last_used: string
): ScoreBreakdown {
  const raw_score = result.success ? 1 : 0;
  const recency_score = compute_recency_decay(last_used);
  const consistency_score = compute_consistency(result, stats);

  const final_fitness =
    raw_score * SUCCESS_WEIGHT +
    recency_score * RECENCY_WEIGHT +
    consistency_score * CONSISTENCY_WEIGHT;

  const clamped = Math.min(1, Math.max(0, final_fitness));

  return {
    raw_score,
    recency_score,
    consistency_score,
    final_fitness: clamped,
    thresholds: {
      active: clamped >= THRESHOLD_ACTIVE,
      re_distill: clamped >= THRESHOLD_REDISTILL && clamped < THRESHOLD_ACTIVE,
      deprecated: clamped < THRESHOLD_REDISTILL,
    },
  };
}

/**
 * Compute a rolling fitness from historical stats (no new result).
 * Used for SKILLs that haven't been invoked recently.
 */
export function apex_scoring_from_stats(stats: SkillStats): ScoreBreakdown {
  if (stats.invocation_count === 0) {
    return {
      raw_score: 0,
      recency_score: 0,
      consistency_score: 0,
      final_fitness: 0,
      thresholds: { active: false, re_distill: false, deprecated: true },
    };
  }

  const success_rate = stats.success_count / stats.invocation_count;
  const recency_score = compute_recency_decay(stats.last_used);
  const avg_duration = stats.total_duration_ms / stats.invocation_count;

  // Consistency: penalize if avg duration is extremely high (proxy for failures/hangs)
  const consistency_score = Math.min(1, 5000 / Math.max(avg_duration, 1));

  const final_fitness =
    success_rate * SUCCESS_WEIGHT +
    recency_score * RECENCY_WEIGHT +
    consistency_score * CONSISTENCY_WEIGHT;

  const clamped = Math.min(1, Math.max(0, final_fitness));

  return {
    raw_score: success_rate,
    recency_score,
    consistency_score,
    final_fitness: clamped,
    thresholds: {
      active: clamped >= THRESHOLD_ACTIVE,
      re_distill: clamped >= THRESHOLD_REDISTILL && clamped < THRESHOLD_ACTIVE,
      deprecated: clamped < THRESHOLD_REDISTILL,
    },
  };
}

// ─── Internal ───────────────────────────────────────────────────────────────

/**
 * Recency decay: exponential decay with half-life of RECENCY_HALF_LIFE_HOURS.
 *
 *   recency_decay = 0.5^(hours_since_last_use / half_life)
 *
 * A SKILL used 3 days ago scores 0.5. 6 days ago scores 0.25. 9 days ago scores 0.125.
 */
function compute_recency_decay(last_used: string): number {
  if (!last_used) return 0;

  let hours: number;
  try {
    const lastDate = new Date(last_used);
    hours = differenceInHours(new Date(), lastDate);
  } catch {
    return 0;
  }

  if (hours < 0) return 1;   // future? treat as fresh
  if (hours > 24 * 30) return 0; // older than 30 days → effectively 0

  return Math.pow(0.5, hours / RECENCY_HALF_LIFE_HOURS);
}

/**
 * Tool call consistency: how often does this SKILL use the same tools?
 * High consistency → higher score. Chaotic tool usage → penalty.
 *
 * Implemented as: consistency = 1 / (1 + variance_of_tool_call_count)
 * Clamped to [0, 1].
 */
function compute_consistency(
  result: ExecutionResult,
  stats: SkillStats
): number {
  if (stats.invocation_count === 0) return 1; // first use — neutral

  const current_tool_count = result.tool_calls?.length ?? 0;
  if (current_tool_count === 0) return 0.5;   // no tools used — neutral

  // Compute coefficient of variation for tool count across all invocations
  const counts = stats.recent_results
    .map(r => r.tool_calls?.length ?? 0)
    .filter(c => c > 0);

  if (counts.length < 2) return 1; // not enough data — assume consistent

  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance =
    counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length;
  const cv = Math.sqrt(variance) / Math.max(mean, 1);

  // CoV of 0 → consistency 1. CoV of 1+ → consistency → 0.
  return Math.max(0, Math.min(1, 1 / (1 + cv)));
}