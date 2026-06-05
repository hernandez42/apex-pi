// src/understand/pipeline.ts
// Multi-phase /understand: scan → analyze → explain.
// Distilled from Lum1104/Understand-Anything's six-agent pipeline.
// Each phase is a single LLM call (or zero) so we don't burn memory on
// orchestration state.

import { Codegraph, getCodegraph } from "../codegraph/index.ts";
import { complete, getModel, type Model } from "@earendil-works/pi-ai";
import { log } from "../log.ts";
import { config } from "../config.ts";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface UnderstandOptions {
  root: string;
  maxFiles?: number;
  maxFileKb?: number;
  language?: string;
  /** Skip the LLM explain phase, return only the deterministic graph. */
  graphOnly?: boolean;
  /** Extra instruction appended to the explainer prompt. */
  focus?: string;
}

export interface UnderstandResult {
  root: string;
  scanned: number;
  skipped: number;
  symbols: number;
  edges: number;
  languages: Record<string, number>;
  summary: string;
  tours: GuidedTour[];
  hotspots: Array<{ file: string; symbols: number; exports: number }>;
  graph: { nodes: Array<{ data: { id: string; label: string; kind: string } }>; edges: Array<{ data: { id: string; source: string; target: string; label: string } }> };
}

export interface GuidedTour {
  title: string;
  steps: Array<{ file: string; symbol: string; line: number; why: string }>;
}

const SKIP_DIR = /(^|[\\/])(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|dist|build|target|\.turbo|\.vercel|\.cache|coverage|out|vendor|__pycache__|\.pytest_cache|\.idea|\.vscode|\.data)([\\/]|$)/;
const TEXT_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "cxx", "cc", "hpp", "hxx",
  "cs", "php", "dart", "lua", "scala", "svelte", "vue",
  "md", "mdx", "txt", "toml", "yaml", "yml", "json",
  "html", "css", "scss", "sh", "bash",
]);

export async function understand(opts: UnderstandOptions): Promise<UnderstandResult> {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytes = (opts.maxFileKb ?? 256) * 1024;
  const root = opts.root;

  // Phase 1: SCAN — build a small, deterministic file inventory.
  const files: Array<{ path: string; rel: string; size: number; lang: string | null }> = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
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
          files.push({ path: full, rel: relative(root, full).replace(/\\/g, "/"), size: st.size, lang: ext });
        }
      }
    }
  }

  // Phase 2: ANALYZE — index symbols / edges via codegraph.
  const cg = getCodegraph();
  await cg.index(root);
  const stats = cg.stats();

  // Phase 3: TOURS — order exported symbols by dependency (no in-deps = root).
  const tours: GuidedTour[] = buildTours(cg);

  // Phase 4: HOTSPOTS — files with most symbols / most exports.
  const hotspots = computeHotspots(cg);

  // Phase 5: EXPLAIN — single LLM call summarises the architecture.
  let summary: string;
  if (opts.graphOnly) {
    summary = `[graph-only mode] scanned ${files.length} files across ${Object.keys(stats.languages).length} languages; ${stats.symbols} symbols / ${stats.edges} edges.`;
  } else {
    summary = await explainWithLlm({ root, files, stats, cg, focus: opts.focus });
  }

  const graph = toCytoscape(cg);

  log.info("understand.done", { scanned: files.length, symbols: stats.symbols, edges: stats.edges });

  return {
    root,
    scanned: files.length,
    skipped: 0,
    symbols: stats.symbols,
    edges: stats.edges,
    languages: stats.languages,
    summary,
    tours,
    hotspots,
    graph,
  };
}

function buildTours(cg: Codegraph): GuidedTour[] {
  // Pick top-N exported symbols with no incoming edges as roots
  const roots = cg.db
    .query<{ id: string; name: string; path: string; line: number }, []>(
      `SELECT s.id, s.name, s.path, s.line
       FROM symbols s
       LEFT JOIN edges e ON e.dst = s.id
       WHERE s.exported = 1 AND e.id IS NULL
       ORDER BY s.name LIMIT 8`,
    )
    .all();
  if (roots.length === 0) return [];
  return [
    {
      title: "Suggested entry points (no incoming calls)",
      steps: roots.map((r) => ({
        file: r.path,
        symbol: r.name,
        line: r.line,
        why: "No other symbol calls this — likely an entry point or external API surface.",
      })),
    },
  ];
}

function computeHotspots(cg: Codegraph): UnderstandResult["hotspots"] {
  const rows = cg.db
    .query<{ path: string; symbols: number; exports: number }, []>(
      `SELECT path, COUNT(*) AS symbols, SUM(exported) AS exports
       FROM symbols GROUP BY path ORDER BY symbols DESC LIMIT 10`,
    )
    .all();
  return rows.map((r) => ({ file: r.path, symbols: r.symbols, exports: r.exports }));
}

async function explainWithLlm(args: {
  root: string;
  files: Array<{ path: string; rel: string; size: number; lang: string | null }>;
  stats: ReturnType<Codegraph["stats"]>;
  cg: Codegraph;
  focus?: string;
}): Promise<string> {
  const fileTreeSample = args.files
    .slice(0, 200)
    .map((f) => `${f.rel} (${f.lang ?? "?"}, ${(f.size / 1024).toFixed(1)}KB)`)
    .join("\n");
  const hotspots = computeHotspots(args.cg)
    .map((h) => `${h.file}: ${h.symbols} symbols, ${h.exports} exports`)
    .join("\n");
  const prompt = `You are an expert code archaeologist. Given a deterministic file
inventory, a symbol/edge graph and a hotspot list, produce a **plain-English
architectural summary** of the project at: ${args.root}

File tree (first 200 files):
${fileTreeSample}

Languages: ${JSON.stringify(args.stats.languages)}
Hotspots (most symbols per file):
${hotspots}

Stats: ${args.stats.symbols} symbols, ${args.stats.edges} edges.

${args.focus ? `Focus the explanation on: ${args.focus}\n` : ""}
Write a concise (max ~300 words) summary that:
1. Names the project and its main purpose (infer from file/dir names).
2. Lists 3-5 architectural layers / sub-systems.
3. Calls out the most important hotspots and why they matter.
4. Surfaces anything that looks like an entry point (scripts, main.ts, bin/).
Be specific, use file paths. No filler.`;
  try {
    const cfg = config();
    const model: Model<any> = getModel(cfg.llm.provider, cfg.llm.model);
    const res = await complete(model, {
      messages: [
        { role: "system", content: "You are a precise, terse technical writer." },
        { role: "user", content: prompt },
      ],
    });
    const block = res.content.find((p) => p.type === "text");
    return (block && "text" in block ? block.text : "").trim() || `[LLM explain returned no text]`;
  } catch (e) {
    log.warn("understand.llm.failed", { err: (e as Error).message });
    return `[LLM explain skipped: ${(e as Error).message}]`;
  }
}

function toCytoscape(cg: Codegraph): UnderstandResult["graph"] {
  const nodes = cg.db
    .query<{ id: string; name: string; kind: string; path: string }, []>(
      "SELECT id, name, kind, path FROM symbols WHERE exported = 1 LIMIT 400",
    )
    .all()
    .map((n) => ({ data: { id: n.id, label: n.name, kind: n.kind, file: n.path } }));
  const nodeIds = new Set(nodes.map((n) => n.data.id));
  const edges = cg.db
    .query<{ src: string; dst: string; kind: string }, []>(
      "SELECT src, dst, kind FROM edges WHERE kind = 'call' LIMIT 1500",
    )
    .all()
    .filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst))
    .map((e) => ({ data: { id: `${e.src}->${e.dst}`, source: e.src, target: e.dst, label: e.kind } }));
  return { nodes, edges };
}
