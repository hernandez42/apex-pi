/**
 * apex_evolver — 5D-native self-evolution engine
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Core insight: evolution happens in the 5D system, not in a separate SKILL pool.
 *
 * 5D IS the gene pool:
 *   - MemoryRecord.importance  ←→  gene fitness
 *   - MemoryRecord.dimension  ←→  gene type (procedural=skill, semantic=knowledge, etc.)
 *   - MemoryRecord.accessCount ←→  gene usage frequency
 *   - graph_edges             ←→  gene regulatory network
 *   - dream()                 ←→  evolution cycle (decay + promote + dedup)
 *   - health().deltaG         ←→  system-level fitness indicator
 *
 * apex_evolver's job:
 *   1. Monitor system health (deltaG)
 *   2. Trigger dream() cycles when evolution is needed
 *   3. Inject high-importance memories to drive promotion
 *   4. Manage graph relationships between memories (regulatory network)
 *   5. Optionally maintain SKILL.md as a materialized cache
 *
 * The SKILL.md file is NOT the primary store — it is a human-readable
 * cache of frequently-accessed procedural memories from 5D.
 */

import type { MemoryEngine } from "../memory/index.ts";
import type { IngestInput, MemoryRecord } from "../memory/types.ts";
import type { ScoreBreakdown } from "./apex_scoring.ts";
import { THRESHOLD_ACTIVE, THRESHOLD_REDISTILL } from "./apex_scoring.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvolutionAction =
  | { type: "keep"; record: MemoryRecord }
  | { type: "bump_importance"; record: MemoryRecord; newImportance: number }
  | { type: "trigger_dream"; reason: string }
  | { type: "demote"; record: MemoryRecord }
  | { type: "inject"; record: MemoryRecord; reason: string }
  | { type: "relate"; src: string; rel: string; dst: string };

export interface EvolverContext {
  task: import("./apex_search.js").TaskFingerprint;
  result: import("./apex_scoring.js").ExecutionResult;
  record: MemoryRecord | null;  // null → first-time task, no existing memory
  score: ScoreBreakdown;
}

export interface EvolverStats {
  systemDeltaG: number;
  poolHealth: "healthy" | "degraded" | "critical";
  totalMemories: number;
  proceduralCount: number;
  semanticCount: number;
  dreamTriggered: boolean;
  lastDreamAt: number | null;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const DREAM_TRIGGER_DELTA_G = 0.2;     // trigger dream when deltaG < this
const PROMOTION_IMPORTANCE = 0.55;     // working→semantic threshold
const GRAPH_EDGE_WEIGHT = 0.8;         // default relation strength

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Core evolution step: given an execution result, evolve the 5D memory system.
 *
 * @param engine  — the 5D memory engine
 * @param ctx     — evolution context (task, result, record, score)
 * @returns evolution actions taken
 */
export async function apex_evolve(
  engine: MemoryEngine,
  ctx: EvolverContext
): Promise<EvolutionAction[]> {
  const actions: EvolutionAction[] = [];

  // ── Step 1: Ingest the new experience ────────────────────────────────
  const record = await ingest_experience(engine, ctx);

  // ── Step 2: Score the resulting importance ──────────────────────────
  if (!record) return actions;

  const importance = record.importance;

  // ── Step 3: Decide based on thresholds ────────────────────────────

  if (importance >= THRESHOLD_ACTIVE) {
    // Healthy — bump importance slightly on success
    if (ctx.result.success) {
      const newImportance = Math.min(1, importance + 0.05);
      await engine.ingest({
        id: record.id,
        content: record.content,
        dimension: record.dimension,
        tags: record.tags,
        importance: newImportance,
        meta: record.meta,
      });
      actions.push({ type: "bump_importance", record, newImportance });
    }
    actions.push({ type: "keep", record });
  } else if (importance >= THRESHOLD_REDISTILL) {
    // Degraded — bump up but watch carefully
    const newImportance = Math.min(1, importance + 0.02);
    await engine.ingest({
      id: record.id,
      content: record.content,
      dimension: record.dimension,
      tags: record.tags,
      importance: newImportance,
      meta: record.meta,
    });
    actions.push({ type: "bump_importance", record, newImportance });

    // Check if system needs dream
    const health = await engine.health();
    if (health.deltaG < DREAM_TRIGGER_DELTA_G) {
      await engine.dream();
      actions.push({ type: "trigger_dream", reason: `deltaG=${health.deltaG.toFixed(3)} below ${DREAM_TRIGGER_DELTA_G}` });
    }
  } else {
    // Critical — inject a high-importance re-analysis of this problem
    const injectRecord = await engine.ingest({
      content: `[RE-EVOLVE] Task "${ctx.task.intent}" failed. Root cause analysis: ${ctx.result.error ?? "unknown"}. Re-examine approach.`,
      dimension: "episodic",
      tags: ["evolution:critical", `task:${ctx.task.intent}`],
      importance: 0.9,
      meta: {
        taskIntent: ctx.task.intent,
        taskContext: ctx.task.context,
        executionError: ctx.result.error,
        lastAttempt: new Date().toISOString(),
      },
    });
    actions.push({ type: "inject", record: injectRecord, reason: `importance=${importance.toFixed(3)} < ${THRESHOLD_REDISTILL}` });

    // Try to establish causal relation to help dream() discover the issue
    if (ctx.result.error) {
      await engine.relate(
        injectRecord.id,
        "caused_by",
        `error:${ctx.result.error.slice(0, 50)}`,
        0.6,
        "episodic"
      );
      actions.push({ type: "relate", src: injectRecord.id, rel: "caused_by", dst: `error:${ctx.result.error.slice(0, 50)}` });
    }
  }

  return actions;
}

/**
 * System-level health check and maintenance.
 * Call this periodically (e.g., every 100 tasks or daily).
 *
 * Returns current system stats and actions taken.
 */
export async function apex_evolver_maintain(
  engine: MemoryEngine
): Promise<{ stats: EvolverStats; actions: EvolutionAction[] }> {
  const actions: EvolutionAction[] = [];
  const stats = await engine.stats();
  const health = await engine.health();

  let poolHealth: "healthy" | "degraded" | "critical";
  if (health.deltaG > 0.5) poolHealth = "healthy";
  else if (health.deltaG > 0) poolHealth = "degraded";
  else poolHealth = "critical";

  const evolverStats: EvolverStats = {
    systemDeltaG: health.deltaG,
    poolHealth,
    totalMemories: stats.total,
    proceduralCount: stats.byDimension.procedural ?? 0,
    semanticCount: stats.byDimension.semantic ?? 0,
    dreamTriggered: false,
    lastDreamAt: stats.lastDreamAt,
  };

  // If system is degraded, trigger a dream cycle
  if (health.deltaG < DREAM_TRIGGER_DELTA_G) {
    const dreamResult = await engine.dream();
    actions.push({
      type: "trigger_dream",
      reason: `deltaG=${health.deltaG.toFixed(3)} < ${DREAM_TRIGGER_DELTA_G} | decayed=${dreamResult.decayed} promoted=${dreamResult.promoted}`,
    });
    evolverStats.dreamTriggered = true;
  }

  // If procedural pool is too small, inject a skill synthesis prompt
  if ((stats.byDimension.procedural ?? 0) < 5) {
    const injectRecord = await engine.ingest({
      content: `[GROW] Procedural memory pool is sparse (${stats.byDimension.procedural ?? 0} skills). Look for successful patterns in recent episodic memories and distill them into procedural skills.`,
      dimension: "semantic",
      tags: ["evolution:growth", "pool:sparse"],
      importance: 0.8,
    });
    actions.push({ type: "inject", record: injectRecord, reason: "procedural pool too small" });
  }

  return { stats: evolverStats, actions };
}

// ─── Internal ───────────────────────────────────────────────────────────────

/**
 * Ingest a new experience into 5D memory.
 * Determines the right dimension based on execution result.
 */
async function ingest_experience(
  engine: MemoryEngine,
  ctx: EvolverContext
): Promise<MemoryRecord | null> {
  const { task, result } = ctx;

  // Determine dimension based on task type
  let dimension: import("../memory/types.ts").MemoryDimension;
  let importance: number;
  let tags: string[];

  if (result.success) {
    dimension = "procedural";  // successful task → skill
    importance = 0.5;
    tags = [`task:${task.intent}`, "evolution:success"];
  } else {
    dimension = "episodic";   // failed task → event for analysis
    importance = 0.7;         // failures get higher importance for attention
    tags = [`task:${task.intent}`, "evolution:failure"];
  }

  const content = build_experience_content(task, result);
  const meta: Record<string, unknown> = {
    taskIntent: task.intent,
    taskContext: task.context,
    executionSuccess: result.success,
    duration_ms: result.duration_ms,
    tool_calls: result.tool_calls ?? [],
  };

  // Try to dedupe by hashing content
  const rec = await engine.ingest({
    content,
    dimension,
    tags,
    importance,
    meta,
  });

  return rec;
}

function build_experience_content(
  task: import("./apex_search.js").TaskFingerprint,
  result: import("./apex_scoring.js").ExecutionResult
): string {
  if (result.success) {
    return [
      `# SKILL: ${task.intent}`,
      `> Context: ${task.context}`,
      ``,
      `## Successful Execution`,
      `Tool calls: ${(result.tool_calls ?? []).join(" → ")}`,
      `Output: ${result.output ?? "(success)"}`,
    ].join("\n");
  } else {
    return [
      `# FAILED TASK: ${task.intent}`,
      `> Context: ${task.context}`,
      ``,
      `## Failed Execution`,
      `Error: ${result.error ?? "(unknown)"}`,
      `Duration: ${result.duration_ms}ms`,
    ].join("\n");
  }
}