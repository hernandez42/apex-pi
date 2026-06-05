/**
 * apex_distill — 5D-native skill synthesis
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Distills a successful execution into a 5D procedural memory AND
 * optionally writes a human-readable SKILL.md cache.
 *
 * Primary store: 5D memory (procedural dimension, importance = fitness)
 * Optional cache: SKILL.md (materialized view for fast retrieval + human inspection)
 *
 * The SKILL.md file is NOT the source of truth. It is generated from 5D.
 * This means SKILL pool evolution is powered by the 5D dream cycle directly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEngine } from "../memory/index.ts";
import type { MemoryRecord } from "../memory/types.ts";
import { type TaskFingerprint } from "./apex_search.ts";
import { type ExecutionResult } from "./apex_scoring.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DistillConfig {
  skillsDir: string;        // where to write SKILL.md cache
  writeCache: boolean;      // write SKILL.md as well? default true
  tags: string[];           // additional tags for 5D ingest
  importance: number;       // initial importance for the memory
}

export interface DistillResult {
  record: MemoryRecord;
  cachePath: string | null;  // SKILL.md path if writeCache=true
  isNew: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DistillConfig = {
  skillsDir: join(process.cwd(), "skills"),
  writeCache: true,
  tags: [],
  importance: 0.5,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Distill a successful task execution into 5D memory.
 * Optionally also writes a human-readable SKILL.md cache.
 *
 * @param engine  — the 5D memory engine
 * @param task    — the task that was executed
 * @param result  — execution outcome
 * @param config  — optional overrides
 */
export async function apex_distill(
  engine: MemoryEngine,
  task: TaskFingerprint,
  result: ExecutionResult,
  config: Partial<DistillConfig> = {}
): Promise<DistillResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!result.success) {
    // Don't distill failures as procedural skills — they go to episodic
    // The evolver handles failure memories separately
    const rec = await engine.ingest({
      content: build_skill_content(task, result),
      dimension: "episodic",
      tags: [...cfg.tags, `task:${task.intent}`, "evolution:failure"],
      importance: 0.7,  // failures get higher importance
      meta: {
        taskIntent: task.intent,
        taskContext: task.context,
        executionError: result.error,
        duration_ms: result.duration_ms,
        tool_calls: result.tool_calls,
      },
    });
    return { record: rec, cachePath: null, isNew: true };
  }

  // Successful execution → procedural skill
  const rec = await engine.ingest({
    content: build_skill_content(task, result),
    dimension: "procedural",
    tags: [...cfg.tags, `task:${task.intent}`, "evolution:success"],
    importance: cfg.importance,
    meta: {
      taskIntent: task.intent,
      taskContext: task.context,
      duration_ms: result.duration_ms,
      tool_calls: result.tool_calls,
    },
  });

  // Optionally write SKILL.md cache
  let cachePath: string | null = null;
  if (cfg.writeCache) {
    cachePath = await write_skill_cache(cfg.skillsDir, task, result, rec);
  }

  return { record: rec, cachePath, isNew: true };
}

/**
 * Read a 5D procedural memory and generate a SKILL.md file from it.
 * Used to rebuild the cache from 5D state.
 */
export async function apex_distill_rebuild_cache(
  engine: MemoryEngine,
  record: MemoryRecord,
  skillsDir: string
): Promise<string> {
  const task: TaskFingerprint = {
    intent: String(record.meta?.taskIntent ?? record.content.split("\n")[0]),
    context: String(record.meta?.taskContext ?? ""),
    raw: record.content,
  };
  const result: ExecutionResult = {
    success: record.meta?.executionSuccess as boolean ?? true,
    output: record.content,
    error: record.meta?.executionError as string | undefined,
    duration_ms: record.meta?.duration_ms as number ?? 0,
    tool_calls: record.meta?.tool_calls as string[] | undefined,
  };
  return write_skill_cache(skillsDir, task, result, record);
}

// ─── Internal ───────────────────────────────────────────────────────────────

function build_skill_content(task: TaskFingerprint, result: ExecutionResult): string {
  const toolList = (result.tool_calls ?? []).map(t => `- ${t}`).join("\n");
  const output = result.output ?? "(completed successfully)";

  return [
    `# SKILL: ${task.intent}`,
    `> Context: ${task.context || "(none)"}`,
    ``,
    `## When to use`,
    `Use this skill when the user asks for: **${task.intent}**`,
    ``,
    `## Steps`,
    ...(result.tool_calls ?? []).map((tool, i) =>
      `${i + 1}. **${tool}** — execute to ${describe_tool(tool)}`
    ),
    ``,
    `## Tools Used`,
    toolList || "(none)",
    ``,
    `## Expected Outcome`,
    result.success ? `✅ ${output}` : `❌ ${result.error}`,
  ].join("\n");
}

function describe_tool(tool: string): string {
  const descriptions: Record<string, string> = {
    git_status: "check repository status",
    git_commit: "commit changes",
    git_push: "push to remote",
    file_write: "write file content",
    file_edit: "edit existing file",
    terminal: "run shell command",
    apex_search: "query 5D memory for relevant skills",
    apex_ingest: "store experience in 5D memory",
  };
  return descriptions[tool] ?? `execute ${tool}`;
}

async function write_skill_cache(
  skillsDir: string,
  task: TaskFingerprint,
  result: ExecutionResult,
  record: MemoryRecord
): Promise<string> {
  const skillName = task.intent.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const skillDir = join(skillsDir, skillName);
  const cachePath = join(skillDir, "SKILL.md");

  try {
    mkdirSync(skillDir, { recursive: true });
    const content = build_skill_content(task, result);
    writeFileSync(cachePath, content, "utf-8");
  } catch (e) {
    console.error(`[apex_distill] failed to write SKILL.md cache:`, e);
  }

  return cachePath;
}