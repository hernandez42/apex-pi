/**
 * apex_search — Task fingerprint matching against SKILL Gene Pool
 *
 * Pi-mono Self-Evolution Engine · apex-pi
 *
 * Strategy: find the most relevant SKILL for a given task by matching
 * the task's fingerprint (hash of intent + context) against stored SKILLs.
 * Falls back to cold-start execution if no SKILL meets the similarity threshold.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskFingerprint {
  intent: string;       // "fix_git_merge_conflict", "deploy_k8s", etc.
  context: string;      // "pilotdeck/src/mcp/*", "prod-server", etc.
  raw: string;          // original user message or task description
}

export interface SkillMetadata {
  fitness_score: number;
  invocation_count: number;
  success_rate: number;
  last_used: string;    // ISO 8601
  source_task: string;   // SHA(task_fingerprint)
  status: "active" | "re_distilling" | "deprecated";
  tags: string[];       // extracted intent tags
}

export interface SkillMatch {
  path: string;         // absolute path to skills/*.md
  fingerprint: string; // SHA of source_task
  metadata: SkillMetadata;
  similarity: number;   // 0~1, computed by fingerprint overlap
  content: string;      // raw markdown content
}

// ─── Config ─────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(process.cwd(), "skills");
const MIN_SIMILARITY = 0.4;   // below this → cold-start
const MAX_MATCHES = 3;        // top N candidates returned

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Search the SKILL Gene Pool for the most relevant SKILLs for a given task.
 * Returns up to MAX_MATCHES candidates sorted by similarity descending.
 */
export async function apex_search(
  task: TaskFingerprint,
  options: { minSimilarity?: number } = {}
): Promise<SkillMatch[]> {
  const threshold = options.minSimilarity ?? MIN_SIMILARITY;
  const taskFingerprint = compute_fingerprint(task);
  const taskTags = extract_tags(task.intent);

  const candidates = await scan_skill_pool();
  const scored = candidates
    .filter(c => c.metadata.status !== "deprecated")
    .map(c => ({
      ...c,
      similarity: compute_similarity(taskFingerprint, c.fingerprint, taskTags, c.metadata.tags),
    }))
    .filter(c => c.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_MATCHES);

  return scored;
}

/**
 * Given a task, return the single best SKILL or null if none qualifies.
 */
export async function apex_search_best(
  task: TaskFingerprint,
  options: { minSimilarity?: number } = {}
): Promise<SkillMatch | null> {
  const matches = await apex_search(task, options);
  return matches[0] ?? null;
}

// ─── Internal ───────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 fingerprint from task intent + context.
 * Stable — same task always produces same fingerprint.
 */
export function compute_fingerprint(task: TaskFingerprint): string {
  const raw = `${task.intent}::${task.context}::${task.raw}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Extract tags from an intent string.
 * e.g. "fix_git_merge_conflict" → ["fix", "git", "merge", "conflict"]
 */
export function extract_tags(intent: string): string[] {
  return intent
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(t => t.length > 1);
}

/**
 * Scan the skills/ directory and load all SKILL.md files.
 */
async function scan_skill_pool(): Promise<SkillMatch[]> {
  const skills: SkillMatch[] = [];

  let dir: string[];
  try {
    dir = readdirSync(SKILLS_DIR);
  } catch {
    return []; // skills/ doesn't exist yet — empty pool
  }

  for (const file of dir) {
    if (!file.endsWith(".md")) continue;
    const path = join(SKILLS_DIR, file);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    const content = readFileSync(path, "utf-8");
    const metadata = parse_frontmatter(content);
    if (!metadata) continue;

    skills.push({
      path,
      fingerprint: metadata.source_task ?? basename(file, ".md"),
      metadata,
      similarity: 0, // filled in by caller
      content,
    });
  }

  return skills;
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Returns null if frontmatter is missing or malformed.
 */
function parse_frontmatter(content: string): SkillMetadata | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;

  const raw = match[1];
  const meta: Record<string, unknown> = {};

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
    status: (meta["status"] as SkillMetadata["status"]) ?? "active",
    tags: Array.isArray(meta["tags"])
      ? (meta["tags"] as string[])
      : String(meta["tags"] ?? "")
          .split(",")
          .map(t => t.trim())
          .filter(Boolean),
  };
}

/**
 * Compute similarity between task fingerprint and SKILL fingerprint.
 * Uses Jaccard index on tag sets + fingerprint prefix overlap.
 */
function compute_similarity(
  taskFingerprint: string,
  skillFingerprint: string,
  taskTags: string[],
  skillTags: string[]
): number {
  // Tag Jaccard: |intersection| / |union|
  const intersection = taskTags.filter(t => skillTags.includes(t)).length;
  const union = new Set([...taskTags, ...skillTags]).size;
  const tagScore = union > 0 ? intersection / union : 0;

  // Fingerprint prefix overlap (first 4 hex chars)
  const fpOverlap = [...taskFingerprint]
    .filter((c, i) => i < 4 && c === skillFingerprint[i]).length / 4;

  // Weighted combination
  return tagScore * 0.7 + fpOverlap * 0.3;
}