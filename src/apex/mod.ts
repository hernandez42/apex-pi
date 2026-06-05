/**
 * apex — Pi-mono Self-Evolution Engine
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Entry point. Integrates all apex modules with the 5D memory engine.
 *
 * Architecture (5D-native):
 *
 *   Task → apex_search(5D)
 *              ↓
 *        apex_executor → pi-mono providers
 *              ↓
 *        apex_distill → 5D procedural memory (primary store)
 *              ↓                    ↕ optional SKILL.md cache
 *        apex_scoring → derive fitness from 5D importance
 *              ↓
 *        apex_evolver → evolve 5D via ingest + dream + relate
 *
 * The 5D system IS the Gene/Genome equivalent:
 *   importance  ←→ fitness
 *   dream()    ←→ evolution cycle
 *   deltaG     ←→ system health / selection pressure
 *   graph      ←→ regulatory network
 */

import type { MemoryEngine } from "../memory/index.ts";
import type { MemoryRecord } from "../memory/types.ts";
import { apex_search, apex_search_best_skill, type TaskFingerprint } from "./apex_search.js";
import { apex_scoring, apex_scoring_pool, type ExecutionResult } from "./apex_scoring.js";
import { apex_evolve, apex_evolver_maintain, type EvolutionAction, type EvolverStats } from "./apex_evolver.js";
import { apex_distill, type DistillResult } from "./apex_distill.js";

// ─── Public API ─────────────────────────────────────────────────────────────

export type { TaskFingerprint } from "./apex_search.js";
export type { ExecutionResult } from "./apex_scoring.js";
export type { EvolutionAction, EvolverStats } from "./apex_evolver.js";

export interface ApexConfig {
  minImportance: number;      // minimum importance for SKILL reuse
  dreamTriggerDeltaG: number; // trigger dream when deltaG < this
  cacheSkills: boolean;       // write SKILL.md cache on distill
}

export interface ApexResult {
  usedSkill: boolean;
  record: MemoryRecord | null;
  distillResult: DistillResult | null;
  actions: EvolutionAction[];
  fitness: number;
}

/**
 * Run one apex self-evolution cycle.
 *
 * @param engine   — the 5D memory engine
 * @param task     — incoming task
 * @param executor — async function(task) → ExecutionResult
 * @param config   — optional apex config
 */
export async function apex_run(
  engine: MemoryEngine,
  task: TaskFingerprint,
  executor: (task: TaskFingerprint) => Promise<ExecutionResult>,
  config: Partial<ApexConfig> = {}
): Promise<ApexResult> {
  // Step 1: Search 5D for relevant skills
  const searchResult = await apex_search(engine, task, { systemHealth: true });
  const bestSkill = await apex_search_best_skill(
    engine,
    task,
    { minImportance: config.minImportance ?? 0.3 }
  );

  // Step 2: Execute the task
  const result = await executor(task);

  // Step 3: Distill into 5D
  const distillResult = await apex_distill(engine, task, result, {
    writeCache: config.cacheSkills ?? true,
  });

  // Step 4: Score
  let fitness = distillResult.record.importance;
  let scoreBreakdown: ReturnType<typeof apex_scoring> | null = null;

  if (bestSkill?.hit.record) {
    scoreBreakdown = await apex_scoring(engine, bestSkill.hit.record, result);
    fitness = scoreBreakdown.profile.overallFitness;
  }

  // Step 5: Evolve
  const actions = await apex_evolve(engine, {
    task,
    result,
    record: bestSkill?.hit.record ?? null,
    score: scoreBreakdown ?? {
      executionSuccess: result.success,
      profile: {
        importance: distillResult.record.importance,
        accessCount: distillResult.record.accessCount,
        lastUsed: distillResult.record.accessedAt,
        recencyScore: 1,
        consistencyScore: 0.5,
        systemDeltaG: searchResult.systemDeltaG,
        overallFitness: distillResult.record.importance,
      },
      thresholds: {
        active: distillResult.record.importance >= 0.6,
        reDistill: distillResult.record.importance >= 0.3 && distillResult.record.importance < 0.6,
        deprecated: distillResult.record.importance < 0.3,
      },
    },
  });

  return {
    usedSkill: !!bestSkill,
    record: distillResult.record,
    distillResult,
    actions,
    fitness,
  };
}

/**
 * Periodic maintenance: check system health and trigger evolution if needed.
 * Call this on a schedule (e.g., daily or every 100 tasks).
 */
export async function apex_maintain(
  engine: MemoryEngine
): Promise<{ stats: EvolverStats; actions: EvolutionAction[] }> {
  return apex_evolver_maintain(engine);
}

// Re-export all modules
export { apex_search, apex_search_best_skill } from "./apex_search.js";
export { apex_scoring, apex_scoring_pool } from "./apex_scoring.js";
export { apex_evolve, apex_evolver_maintain } from "./apex_evolver.js";
export { apex_distill } from "./apex_distill.js";