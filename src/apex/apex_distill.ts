/**
 * apex_distill — Successful execution path → SKILL.md write/update
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * This is the core gene-writing function. Every successful task execution
 * can produce a new SKILL or update an existing one.
 *
 * SKILL.md format:
 * ---
 * fitness_score: 0.82
 * invocation_count: 47
 * success_rate: 0.94
 * last_used: 2026-06-05T13:00
 * source_task: SHA(task_fingerprint)
 * status: active | re_distilling | deprecated
 * tags: [fix, git, merge, conflict]
 * ---
 * ## Execution Path
 *
 * ### Context
 * (relevant workspace context captured at execution time)
 *
 * ### Steps
 * 1. ...
 * 2. ...
 *
 * ### Tools Used
 * - git, file_edit, ...
 *
 * ### Outcome
 * Success: ...
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { extract_tags, compute_fingerprint, type TaskFingerprint } from "./apex_search.js";
import { apex_scoring, THRESHOLD_ACTIVE } from "./apex_scoring.js";
import type { ExecutionResult, SkillStats } from "./apex_scoring.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DistillConfig {
  skills_dir: string;
  status: "active" | "re_distilling" | "deprecated";
  existing_path?: string; // if provided → update existing SKILL
  force?: boolean;        // overwrite even if fitness is high
}

export interface DistillResult {
  path: string;
  fingerprint: string;
  is_new: boolean;
  fitness_score: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DistillConfig = {
  skills_dir: join(process.cwd(), "skills"),
  status: "active",
  force: false,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Distill a successful execution into a SKILL.md file.
 *
 * @param task     — the task that was executed
 * @param result   — outcome of the execution
 * @param stats    — historical stats (for computing initial fitness)
 * @param config   — optional overrides
 * @returns path to the created/updated SKILL file
 */
export async function apex_distill(
  task: TaskFingerprint,
  result: ExecutionResult,
  stats: SkillStats,
  config: Partial<DistillConfig> = {}
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Ensure skills directory exists
  mkdirSync(cfg.skills_dir, { recursive: true });

  const fingerprint = compute_fingerprint(task);
  const tags = extract_tags(task.intent);
  const score = apex_scoring(result, stats, new Date().toISOString());

  // Determine fitness: use apex_scoring result if new, keep existing if higher
  let fitness_score = score.final_fitness;
  let invocation_count = 1;
  let success_count = result.success ? 1 : 0;
  let last_used = new Date().toISOString();

  if (cfg.existing_path && existsSync(cfg.existing_path)) {
    // Update existing SKILL — preserve best fitness
    const existing = load_existing_metadata(cfg.existing_path);
    if (existing) {
      invocation_count = (existing.invocation_count ?? 0) + 1;
      success_count = (existing.success_count ?? 0) + (result.success ? 1 : 0);
      fitness_score = Math.max(existing.fitness_score ?? 0, fitness_score);
      last_used = new Date().toISOString();
    }
  }

  const skill_path = cfg.existing_path ?? build_skill_path(cfg.skills_dir, fingerprint);
  const is_new = !existsSync(skill_path);

  const content = build_skill_content({
    task,
    result,
    fingerprint,
    tags,
    fitness_score,
    invocation_count,
    success_count,
    last_used,
    status: cfg.status,
    is_update: !!cfg.existing_path,
  });

  writeFileSync(skill_path, content, "utf-8");
  return skill_path;
}

// ─── Internal ───────────────────────────────────────────────────────────────

function build_skill_path(skills_dir: string, fingerprint: string): string {
  return join(skills_dir, `${fingerprint}.md`);
}

function build_skill_content(opts: {
  task: TaskFingerprint;
  result: ExecutionResult;
  fingerprint: string;
  tags: string[];
  fitness_score: number;
  invocation_count: number;
  success_count: number;
  last_used: string;
  status: DistillConfig["status"];
  is_update: boolean;
}): string {
  const {
    task, result, fingerprint, tags,
    fitness_score, invocation_count, success_count, last_used, status,
  } = opts;

  const success_rate = invocation_count > 0
    ? (success_count / invocation_count).toFixed(3)
    : "0.000";

  const frontmatter = [
    "---",
    `fitness_score: ${fitness_score.toFixed(3)}`,
    `invocation_count: ${invocation_count}`,
    `success_rate: ${success_rate}`,
    `last_used: ${last_used}`,
    `source_task: ${fingerprint}`,
    `status: ${status}`,
    `tags: [${tags.join(", ")}]`,
    "---",
    "",
  ].join("\n");

  const steps = distill_steps(result);
  const context = result.context_snapshot
    ? `### Context\n${result.context_snapshot}\n`
    : "";

  const tool_list = result.tool_calls
    ? `### Tools Used\n${result.tool_calls.map(t => `- ${t}`).join("\n")}\n`
    : "";

  const outcome = result.success
    ? `### Outcome\n✅ Success — ${result.output ?? "(no output)"}\n`
    : `### Outcome\n❌ Failure — ${result.error ?? "(unknown error)"}\n`;

  return [
    frontmatter,
    "# SKILL",
    "",
    `> Task: **${task.intent}**` + (task.context ? ` | Context: ${task.context}` : ""),
    `> Fingerprint: \`${fingerprint}\``,
    "",
    "## Execution Path",
    "",
    context,
    "### Steps",
    steps,
    "",
    tool_list,
    outcome,
    "---",
    "",
    "*This SKILL was auto-generated by apex_distill (apex-pi self-evolution engine).*",
    "*Do not edit the frontmatter. Edit the steps above to improve this SKILL.*",
  ].join("\n");
}

/**
 * Convert an execution result's output into readable step-by-step markdown.
 * Parses tool call patterns and formats them as numbered steps.
 */
function distill_steps(result: ExecutionResult): string {
  if (!result.tool_calls || result.tool_calls.length === 0) {
    return `1. Executed task: ${result.output ?? "(completed)"}`;
  }

  return result.tool_calls
    .map((tool, i) => `${i + 1}. \`${tool}\` → ${describe_tool_result(tool, result.output ?? "")}`)
    .join("\n");
}

function describe_tool_result(tool: string, output: string): string {
  // Extract relevant part of output for this tool
  if (!output) return "(completed)";
  // Truncate to 200 chars for readability in SKILL
  return output.length > 200 ? output.slice(0, 200) + "..." : output;
}

interface ExistingMetadata {
  fitness_score: number;
  invocation_count: number;
  success_count: number;
  success_rate: number;
  last_used: string;
  status: string;
}

function load_existing_metadata(path: string): ExistingMetadata | null {
  try {
    const content = readFileSync(path, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return null;
    const raw = match[1];
    const meta: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return {
      fitness_score: Number(meta["fitness_score"] ?? 0),
      invocation_count: Number(meta["invocation_count"] ?? 0),
      success_count: Math.round(
        Number(meta["success_rate"] ?? 0) * Number(meta["invocation_count"] ?? 1)
      ),
      success_rate: Number(meta["success_rate"] ?? 0),
      last_used: meta["last_used"] ?? "",
      status: meta["status"] ?? "active",
    };
  } catch {
    return null;
  }
}

/**
 * Full closed-loop integration test (for debugging / CI).
 * Run this to verify the entire pipeline works.
 */
export async function apex_distill_self_test(): Promise<void> {
  const test_task: TaskFingerprint = {
    intent: "test_apex_distill",
    context: "unit-test",
    raw: "Verify apex_distill self-evolution closed loop",
  };
  const test_result: ExecutionResult = {
    success: true,
    output: "Self-test passed",
    duration_ms: 42,
    tool_calls: ["git_status", "file_write"],
  };
  const test_stats: SkillStats = {
    invocation_count: 0,
    success_count: 0,
    total_duration_ms: 0,
    last_used: new Date().toISOString(),
    recent_results: [],
  };

  const path = await apex_distill(test_task, test_result, test_stats, {
    skills_dir: "/tmp/apex-pi-test-skills",
    status: "active",
  });

  console.log(`[apex_distill self-test] SKILL written to: ${path}`);

  const content = readFileSync(path, "utf-8");
  if (!content.includes("fitness_score:")) {
    throw new Error("Self-test failed: frontmatter missing");
  }
  if (!content.includes("test_apex_distill")) {
    throw new Error("Self-test failed: task intent not found in content");
  }

  console.log("[apex_distill self-test] ✅ All checks passed");
}