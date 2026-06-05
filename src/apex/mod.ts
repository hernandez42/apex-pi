/**
 * apex — Pi-mono Self-Evolution Engine
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Entry point for the apex self-evolution loop.
 * Integrates apex_search + apex_executor + apex_scoring + apex_evolver + apex_distill.
 *
 * Usage:
 *   import { apex_run } from "src/apex/mod.ts";
 *   await apex_run(task, executor);
 */

import { apex_search, type TaskFingerprint } from "./apex_search.js";
import { apex_scoring, THRESHOLD_ACTIVE } from "./apex_scoring.js";
import { apex_evolve, apex_evolver_cull } from "./apex_evolver.js";
import { apex_distill } from "./apex_distill.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type { TaskFingerprint, SkillMatch } from "./apex_search.js";
export type { ExecutionResult, ScoreBreakdown } from "./apex_scoring.js";
export type { EvolutionAction } from "./apex_evolver.js";

export interface ApexConfig {
  min_similarity: number;
  max_skills: number;
  grace_period_invocations: number;
}

export interface ApexResult {
  used_skill: boolean;
  skill_path: string | null;
  execution_result: import("./apex_scoring.js").ExecutionResult;
  score: import("./apex_scoring.js").ScoreBreakdown;
  action: import("./apex_evolver.js").EvolutionAction;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run one apex self-evolution cycle.
 *
 * @param task      — incoming task
 * @param executor  — async function(task) → ExecutionResult
 * @param config    — optional apex config
 */
export async function apex_run(
  task: TaskFingerprint,
  executor: (task: TaskFingerprint) => Promise<import("./apex_scoring.js").ExecutionResult>,
  config: Partial<ApexConfig> = {}
): Promise<ApexResult> {
  // Step 1: Search SKILL pool
  const match = await apex_search(task, { minSimilarity: config.min_similarity ?? 0.4 });
  const best_match = match[0] ?? null;

  // Step 2: Execute (via SKILL path if found, or cold-start)
  const result = await executor(task);

  // Step 3: Get or init stats for this SKILL
  const stats = best_match
    ? load_stats_from_skill(best_match.content)
    : empty_stats();

  // Step 4: Score execution result
  const score = apex_scoring(result, stats, new Date().toISOString());

  // Step 5: Evolve — decide what to do with this SKILL
  const action = await apex_evolve({
    task,
    result,
    stats,
    score,
    skill_path: best_match?.path,
  });

  return {
    used_skill: !!best_match,
    skill_path: best_match?.path ?? null,
    execution_result: result,
    score,
    action,
  };
}

/**
 * Periodic maintenance: cull low-fitness SKILLs when pool exceeds limit.
 * Call this on a schedule (e.g., daily or every 100 tasks).
 */
export async function apex_maintain(
  config: Partial<ApexConfig> = {}
): Promise<{ culled: number; deleted: string[] }> {
  return apex_evolver_cull({
    max_skills: config.max_skills ?? 200,
  });
}

// ─── Internal helpers ───────────────────────────────────────────────────────

import type { SkillStats, ExecutionResult } from "./apex_scoring.js";

function empty_stats(): SkillStats {
  return {
    invocation_count: 0,
    success_count: 0,
    total_duration_ms: 0,
    last_used: new Date().toISOString(),
    recent_results: [],
  };
}

function load_stats_from_skill(content: string): SkillStats {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return empty_stats();
  const raw = match[1];
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const invocations = Number(meta["invocation_count"] ?? 0);
  const success_rate = Number(meta["success_rate"] ?? 0);
  return {
    invocation_count: invocations,
    success_count: Math.round(success_rate * invocations),
    total_duration_ms: 0,
    last_used: meta["last_used"] ?? new Date().toISOString(),
    recent_results: [],
  };
}

// Re-export all modules for external use
export { apex_search, apex_search_best } from "./apex_search.js";
export { apex_scoring, apex_scoring_from_stats, THRESHOLD_ACTIVE, THRESHOLD_REDISTILL } from "./apex_scoring.js";
export { apex_evolve, apex_evolver_cull } from "./apex_evolver.js";
export { apex_distill, apex_distill_self_test } from "./apex_distill.js";