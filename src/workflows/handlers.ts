// src/workflows/handlers.ts
//
// Built-in task handlers registered with the Absurd engine. Each handler
// is a thin wrapper around an existing apex-pi operation: the handler
// splits the work into a few checkpointed steps so a process crash does
// not force a full re-run.
//
// To add a new durable workflow:
//   1. Implement it here as a `(params, ctx) => Promise<result>`.
//   2. Register it in `registerBuiltinHandlers` below.
//   3. Expose a `spawn<Name>(params)` helper in `src/workflows/<name>.ts`
//      that wraps `spawnWorkflow("<name>", params)`.
//   4. Add an HTTP route in `src/http/server.ts` (see `mountWorkflows`).

import type { TaskContext, TaskResultSnapshot, JsonValue } from "absurd-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { understand, type UnderstandOptions, type UnderstandResult } from "../understand/pipeline.ts";
import { log } from "../log.ts";
import { getCodegraph } from "../codegraph/index.ts";

interface AbsurdLike {
  registerTask<P = unknown, R = unknown>(
    opts: { name: string; queue?: string; defaultMaxAttempts?: number },
    handler: (params: P, ctx: TaskContext) => Promise<R>,
  ): void;
}

/** "understand" workflow: the 5-phase understand pipeline, split into
 *  3 checkpointed steps. The scan and the LLM call are the two most
 *  expensive steps; tours/hotspots are derived from codegraph and are
 *  cheap enough to re-compute on retry. */
async function understandTask(
  params: UnderstandOptions,
  ctx: TaskContext,
): Promise<UnderstandResult> {
  // Step 1: scan + analyse. We expose a smaller "scan" + "analyse" pair
  // because some projects have huge file trees (10k+ files) and the scan
  // alone can take several seconds. Splitting them lets the LLM step
  // skip ahead if the scan already happened on a previous run.
  const inventory = await ctx.step("scan", async () => {
    return await scanFiles(params);
  });
  // Step 2: build codegraph. This is the heaviest deterministic step on
  // large repos and is fully cacheable.
  const analysis = await ctx.step("analyse", async () => {
    const cg = getCodegraph();
    await cg.index(params.root);
    return cg.stats();
  });
  // Step 3: explain with LLM. Crash-safe: the result is cached, so a
  // re-run returns the previous summary without a second API call.
  const summary = await ctx.step("explain", async () => {
    if (params.graphOnly) {
      return `[graph-only mode] scanned ${inventory.length} files across ${Object.keys(analysis.languages).length} languages; ${analysis.symbols} symbols / ${analysis.edges} edges.`;
    }
    return await explainWithLlm(params, inventory, analysis);
  });
  // Final assembly: tours and hotspots are derived cheaply from
  // codegraph. We do not checkpoint this — it's microseconds of work and
  // depends on the in-process codegraph state.
  const cg = getCodegraph();
  const tours = buildToursFromStats(analysis, cg);
  const hotspots = buildHotspotsFromStats(analysis, cg);
  return {
    root: params.root,
    scanned: inventory.length,
    skipped: 0,
    symbols: analysis.symbols,
    edges: analysis.edges,
    languages: analysis.languages,
    summary,
    tours,
    hotspots,
    graph: { nodes: [], edges: [] },
  };
}

/** Parameters for the durable `apex_distill` workflow. Mirrors the
 *  in-process `apex_distill` tool but adds `skillsDir` because the
 *  worker thread does not necessarily have the same `config()` state
 *  as the main process. */
export interface DistillParams {
  /** Lower-case skill id, e.g. "release-checklist". */
  name: string;
  /** Sequence of (tool, input, output_summary) triples that worked. */
  steps: Array<{ tool: string; input?: unknown; output?: string }>;
  /** Target directory; the worker writes `${skillsDir}/${name}/SKILL.md`. */
  skillsDir: string;
  /** Optional free-form "when to use" hint, written into the SKILL.md. */
  whenToUse?: string;
}

export interface DistillResult {
  name: string;
  path: string;
  bytes: number;
  steps: number;
}

/** Synthesise a SKILL.md from a successful tool-call sequence. This is
 *  the durable equivalent of the in-process `apex_distill` tool in
 *  `src/extensions/memory.ts`. The checkpointed step is the I/O itself:
 *  the markdown is rendered once and persisted; re-running returns the
 *  same path without re-rendering. */
async function distillTask(
  params: DistillParams,
  ctx: TaskContext,
): Promise<DistillResult> {
  if (!params.name) throw new Error("name is required");
  if (!params.steps || params.steps.length === 0) throw new Error("steps must contain at least 1 entry");
  if (!params.skillsDir) throw new Error("skillsDir is required (worker has no config() of its own)");

  const written = await ctx.step("write", async () => {
    const name = String(params.name).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const lines: string[] = [
      `# ${name}`,
      ``,
      `> Distilled automatically from a successful agent run.`,
      ``,
      `## When to use`,
      ``,
      `${params.whenToUse?.trim() || "Activate this skill when the user asks for the same multi-step outcome."}`,
      ``,
      `## Steps`,
      ``,
    ];
    for (const s of params.steps) {
      const input = s.input !== undefined ? ` (input: ${JSON.stringify(s.input)})` : "";
      const out = (s.output ?? "").slice(0, 280);
      lines.push(`1. **${s.tool}**${input}`);
      if (out) lines.push(`   - Expected output: \`${out.replace(/\n/g, " ")}\``);
    }
    lines.push(``);
    const skillDir = join(params.skillsDir, name);
    mkdirSync(skillDir, { recursive: true });
    const path = join(skillDir, "SKILL.md");
    const text = lines.join("\n") + "\n";
    writeFileSync(path, text, "utf8");
    return { name, path, bytes: Buffer.byteLength(text, "utf8") };
  });

  log.info("workflows.apex_distill.done", {
    name: written.name,
    path: written.path,
    bytes: written.bytes,
    steps: params.steps.length,
  });
  return { ...written, steps: params.steps.length };
}

/** Test/utility: list the workflows registered with the engine. */
export function builtinWorkflowNames(): string[] {
  return ["understand", "apex_distill"];
}

/** Register all built-in workflows against the given Absurd client. */
export function registerBuiltinHandlers(client: AbsurdLike): void {
  client.registerTask<UnderstandOptions, UnderstandResult>(
    { name: "understand", defaultMaxAttempts: 2 },
    understandTask,
  );
  client.registerTask<DistillParams, DistillResult>(
    { name: "apex_distill", defaultMaxAttempts: 3 },
    distillTask,
  );
}

// ─── local helpers (do not depend on ctx) ─────────────────────────────

async function scanFiles(opts: UnderstandOptions): Promise<Array<{ rel: string; size: number; lang: string | null }>> {
  const { readdirSync, statSync } = await import("node:fs");
  const { join, relative } = await import("node:path");
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytes = (opts.maxFileKb ?? 256) * 1024;
  const SKIP_DIR = /(^|[\\/])(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|dist|build|target|\.turbo|\.vercel|\.cache|coverage|out|vendor|__pycache__|\.pytest_cache|\.idea|\.vscode|\.data)([\\/]|$)/;
  const TEXT_EXT = new Set([
    "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "py", "rb", "go", "rs", "java", "kt", "swift",
    "c", "h", "cpp", "cxx", "cc", "hpp", "hxx",
    "cs", "php", "dart", "lua", "scala", "svelte", "vue",
    "md", "mdx", "txt", "toml", "yaml", "yml", "json",
    "html", "css", "scss", "sh", "bash",
  ]);
  const out: Array<{ rel: string; size: number; lang: string | null }> = [];
  const stack = [opts.root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e);
      if (SKIP_DIR.test(full)) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && st.size > 0 && st.size <= maxBytes) {
        const ext = (e.split(".").pop() ?? "").toLowerCase();
        if (TEXT_EXT.has(ext)) {
          out.push({ rel: relative(opts.root, full).replace(/\\/g, "/"), size: st.size, lang: ext });
        }
      }
    }
  }
  return out;
}

async function explainWithLlm(
  opts: UnderstandOptions,
  files: Array<{ rel: string; size: number; lang: string | null }>,
  stats: { symbols: number; edges: number; languages: Record<string, number> },
): Promise<string> {
  const { complete } = await import("@earendil-works/pi-ai");
  const { resolveModel } = await import("../llm.ts");
  const fileTreeSample = files
    .slice(0, 200)
    .map((f) => `${f.rel} (${f.lang ?? "?"}, ${(f.size / 1024).toFixed(1)}KB)`)
    .join("\n");
  const prompt = `You are an expert code archaeologist. Given a deterministic file
inventory and stats, produce a plain-English architectural summary of: ${opts.root}

File tree (first 200 files):
${fileTreeSample}

Languages: ${JSON.stringify(stats.languages)}
Stats: ${stats.symbols} symbols, ${stats.edges} edges.

${opts.focus ? `Focus the explanation on: ${opts.focus}\n` : ""}
Write a concise (max ~300 words) summary that names the project, lists 3-5
layers, calls out hotspots, and surfaces entry points. Be specific.`;
  try {
    const model = resolveModel();
    const res = await complete(model, {
      systemPrompt: "You are a precise, terse technical writer.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    });
    const block = res.content.find((p) => p.type === "text");
    return (block && "text" in block ? block.text : "").trim() || "[LLM explain returned no text]";
  } catch (e) {
    return `[LLM explain skipped: ${(e as Error).message}]`;
  }
}

function buildToursFromStats(_stats: unknown, cg: ReturnType<typeof getCodegraph>) {
  const rows = cg.db
    .query<{ id: string; name: string; path: string; line: number }, []>(
      `SELECT s.id, s.name, s.path, s.line
       FROM symbols s
       LEFT JOIN edges e ON e.dst = s.id
       WHERE s.exported = 1 AND e.id IS NULL
       ORDER BY s.name LIMIT 8`,
    )
    .all();
  if (rows.length === 0) return [];
  return [{
    title: "Suggested entry points (no incoming calls)",
    steps: rows.map((r) => ({
      file: r.path,
      symbol: r.name,
      line: r.line,
      why: "No other symbol calls this — likely an entry point or external API surface.",
    })),
  }];
}

function buildHotspotsFromStats(
  _stats: unknown,
  cg: ReturnType<typeof getCodegraph>,
): Array<{ file: string; symbols: number; exports: number }> {
  return cg.db
    .query<{ path: string; symbols: number; exports: number }, []>(
      `SELECT path, COUNT(*) AS symbols, SUM(exported) AS exports
       FROM symbols GROUP BY path ORDER BY symbols DESC LIMIT 10`,
    )
    .all()
    .map((r) => ({ file: r.path, symbols: r.symbols, exports: r.exports }));
}

// Suppress unused import warnings for types we may re-export later.
export type { TaskContext, TaskResultSnapshot, JsonValue };
