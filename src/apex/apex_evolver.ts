/**
 * apex_evolver — Fitness threshold check → re_distill or 淘汰
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Lifecycle:
 *   active       → fitness >= 0.6  → normal operation
 *   re_distill   → 0.3 <= fitness < 0.6 → trigger apex_distill rewrite
 *   deprecated   → fitness < 0.3  → delete SKILL after grace period
 *
 * The evolver runs after every apex_scoring call and decides what action to take.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { THRESHOLD_ACTIVE, THRESHOLD_REDISTILL, type ScoreBreakdown } from "./apex_scoring.js";
import { apex_distill } from "./apex_distill.js";
import type { TaskFingerprint } from "./apex_search.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvolutionAction =
  | { type: "keep"; skill_path: string }
  | { type: "re_distill"; skill_path: string; reason: string }
  | { type: "promote"; skill_path: string; new_fitness: number }
  | { type: "deprecate"; skill_path: string }
  | { type: "delete"; skill_path: string }
  | { type: "new_skill"; skill_path: string };  // first-time SKILL created

export interface EvolverContext {
  task: TaskFingerprint;
  result: import("./apex_scoring.js").ExecutionResult;
  stats: import("./apex_scoring.js").SkillStats;
  score: ScoreBreakdown;
  skill_path?: string; // undefined → new SKILL
}

export interface EvolverConfig {
  skills_dir: string;
  grace_period_invocations: number;  // how many calls before delete after deprecate
  max_skills: number;                // pool size limit → trigger culling of lowest fitness
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: EvolverConfig = {
  skills_dir: join(process.cwd(), "skills"),
  grace_period_invocations: 3,
  max_skills: 200,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Given an execution result + score, decide what evolution action to take.
 *
 * This is the core decision function of the self-evolution engine.
 */
export async function apex_evolve(
  ctx: EvolverContext,
  config: Partial<EvolverConfig> = {}
): Promise<EvolutionAction> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Ensure skills directory exists
  ensure_skills_dir(cfg.skills_dir);

  const { score, skill_path } = ctx;

  // ── Case 1: No existing SKILL — create first-time SKILL ──
  if (!skill_path) {
    const new_path = await apex_distill(ctx.task, ctx.result, ctx.stats, {
      skills_dir: cfg.skills_dir,
      status: "active",
    });
    return { type: "new_skill", skill_path: new_path };
  }

  // ── Case 2: Active SKILL performing well ──
  if (score.thresholds.active) {
    // Bump fitness slightly on success, hold on failure
    const new_fitness = ctx.result.success
      ? Math.min(1, score.final_fitness + 0.05)
      : score.final_fitness;

    await update_skill_fitness(skill_path, {
      fitness_score: new_fitness,
      invocation_count: ctx.stats.invocation_count + 1,
      last_used: new Date().toISOString(),
    });

    return { type: "keep", skill_path };
  }

  // ── Case 3: Re-distill needed ──
  if (score.thresholds.re_distill) {
    await mark_skill_status(skill_path, "re_distilling");

    // Re-distill: rewrite the SKILL with the new successful path
    await apex_distill(ctx.task, ctx.result, ctx.stats, {
      skills_dir: cfg.skills_dir,
      status: "active",
      existing_path: skill_path,
    });

    return {
      type: "re_distill",
      skill_path,
      reason: `fitness ${score.final_fitness.toFixed(2)} below ${THRESHOLD_ACTIVE}, rewrite triggered`,
    };
  }

  // ── Case 4: Deprecate ──
  if (score.thresholds.deprecated) {
    const current = load_skill_metadata(skill_path);
    const invocation_count = current?.invocation_count ?? 0;

    if (invocation_count >= cfg.grace_period_invocations) {
      // Hard delete after grace period
      await delete_skill(skill_path);
      return { type: "delete", skill_path };
    } else {
      // Mark as deprecated but keep through grace period
      await mark_skill_status(skill_path, "deprecated");
      return { type: "deprecate", skill_path };
    }
  }

  // ── Fallback: keep ──
  return { type: "keep", skill_path };
}

/**
 * Periodic culling: prune the lowest-fitness SKILLs if pool exceeds max_skills.
 * Run this on a schedule (e.g., every 100 tasks or daily).
 */
export async function apex_evolver_cull(
  config: Partial<EvolverConfig> = {}
): Promise<{ culled: number; deleted: string[] }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  ensure_skills_dir(cfg.skills_dir);

  const skills = list_skills(cfg.skills_dir);
  if (skills.length <= cfg.max_skills) {
    return { culled: 0, deleted: [] };
  }

  // Sort by fitness ascending (lowest first)
  skills.sort((a, b) => a.fitness_score - b.fitness_score);

  const to_delete = skills.slice(0, skills.length - cfg.max_skills);
  const deleted: string[] = [];

  for (const skill of to_delete) {
    if (skill.status === "deprecated") {
      await delete_skill(skill.path);
      deleted.push(skill.path);
    }
  }

  return { culled: to_delete.length, deleted };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function ensure_skills_dir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
}

async function update_skill_fitness(
  path: string,
  updates: Partial<{
    fitness_score: number;
    invocation_count: number;
    last_used: string;
    success_rate: number;
  }>
): Promise<void> {
  try {
    const content = readFileSync(path, "utf-8");
    const updated = update_frontmatter(content, updates);
    writeFileSync(path, updated, "utf-8");
  } catch (e) {
    console.error(`[apex_evolver] failed to update fitness for ${path}:`, e);
  }
}

async function mark_skill_status(
  path: string,
  status: "active" | "re_distilling" | "deprecated"
): Promise<void> {
  await update_skill_fitness(path, {});
  try {
    const content = readFileSync(path, "utf-8");
    const updated = update_frontmatter(content, { status });
    writeFileSync(path, updated, "utf-8");
  } catch (e) {
    console.error(`[apex_evolver] failed to mark status for ${path}:`, e);
  }
}

async function delete_skill(path: string): Promise<void> {
  try {
    unlinkSync(path);
  } catch (e) {
    console.error(`[apex_evolver] failed to delete ${path}:`, e);
  }
}

interface SkillSummary {
  path: string;
  fitness_score: number;
  status: "active" | "re_distilling" | "deprecated";
  invocation_count: number;
}

function list_skills(dir: string): SkillSummary[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .map(f => {
        const path = join(dir, f);
        const meta = load_skill_metadata(path);
        return {
          path,
          fitness_score: meta?.fitness_score ?? 0,
          status: meta?.status ?? "active",
          invocation_count: meta?.invocation_count ?? 0,
        };
      });
  } catch {
    return [];
  }
}

interface SkillMeta {
  fitness_score: number;
  invocation_count: number;
  success_rate: number;
  last_used: string;
  source_task: string;
  status: "active" | "re_distilling" | "deprecated";
  tags: string[];
}

function load_skill_metadata(path: string): SkillMeta | null {
  try {
    const content = readFileSync(path, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return null;
    const raw = match[1];
    const meta: Record<string, string | number | string[]> = {};
    for (const line of raw.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      meta[key] = value;
    }
    return {
      fitness_score: Number(meta["fitness_score"] ?? 0),
      invocation_count: Number(meta["invocation_count"] ?? 0),
      success_rate: Number(meta["success_rate"] ?? 0),
      last_used: String(meta["last_used"] ?? ""),
      source_task: String(meta["source_task"] ?? ""),
      status: (meta["status"] as SkillMeta["status"]) ?? "active",
      tags: String(meta["tags"] ?? "")
        .split(",")
        .map(t => t.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

function update_frontmatter(
  content: string,
  updates: Record<string, string | number | null>
): string {
  const match = content.match(/^(---\n[\s\S]*?\n---\n)/);
  if (!match) return content;

  let frontmatter = match[1];

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) continue;
    const regex = new RegExp(`^(${key}:\\s*).*$`, "m");
    if (regex.test(frontmatter)) {
      frontmatter = frontmatter.replace(regex, `$1${value}`);
    } else {
      frontmatter += `${key}: ${value}\n`;
    }
  }

  return content.replace(match[1], frontmatter);
}