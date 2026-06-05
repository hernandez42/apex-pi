// src/codegraph/store.ts
// Lightweight code intelligence layer backed by SQLite + regex.
// The regex-based extractor handles TS/JS/Python/Go/Rust/Java/C/C++/C#/PHP/Ruby
// at a fraction of the memory cost of tree-sitter. The interface matches the
// subset of codegraph-ai/CodeGraph MCP tools that we expose.

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readFileSync } from "node:fs";

const SYMBOL_RE: Array<{ re: RegExp; kind: "function" | "class" | "variable" }> = [
  { re: /\b(?:export\s+)?(?:async\s+)?(?:function|fn|func|def)\s+([A-Za-z_$][\w$]*)/g, kind: "function" },
  { re: /\b(?:export\s+)?(?:class|interface|type|struct|enum|union|trait|object)\s+([A-Za-z_$][\w$]*)/g, kind: "class" },
  { re: /\b(?:const|let|var|val|final)\s+([A-Za-z_$][\w$]*)\s*[:=]/g, kind: "variable" },
];

const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*(?:\.([A-Za-z_$][\w$]*))?\s*\(/g;

export interface Symbol {
  id: string;
  file: string;
  kind: "function" | "class" | "type" | "variable" | "method";
  name: string;
  line: number;
  endLine: number;
  signature?: string;
  exported: boolean;
  language: string;
  summary?: string;
}

export interface Edge {
  src: string;
  dst: string;
  kind: "call" | "import" | "extend" | "implement";
  line: number;
}

export interface ImpactResult {
  symbol: Symbol;
  callers: Symbol[];
  callees: Symbol[];
  filesAffected: string[];
  blastRadius: number;
}

export interface CodegraphStats {
  files: number;
  symbols: number;
  edges: number;
  languages: Record<string, number>;
  lastIndexedAt: number | null;
}

export interface CodegraphOptions {
  dataDir: string;
  maxFileKb?: number;
  maxFiles?: number;
}

const LANG_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp", php: "php", dart: "dart", lua: "lua", scala: "scala",
  svelte: "svelte", vue: "vue",
};

function detectLang(file: string): string | null {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  return LANG_EXT[file.slice(dot + 1).toLowerCase()] ?? null;
}

function idFor(file: string, name: string, line: number): string {
  return `${file}::${name}@${line}`;
}

function shortFile(p: string, root: string): string {
  const r = relative(root, p).replace(/\\/g, "/");
  return r.startsWith("..") ? p : r;
}

const EXCLUDES = [
  /(^|[\/\\])(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|dist|build|target|\.turbo|\.vercel|\.cache|coverage|out|vendor|__pycache__|\.pytest_cache|\.mvn|\.gradle|\.idea|\.vscode|\.DS_Store|\.data|\.apex|\.apex-mem)([\/\\]|$)/,
];

function shouldSkip(p: string): boolean {
  return EXCLUDES.some((re) => re.test(p));
}

export class Codegraph {
  /** Exposed for the /understand pipeline which composes custom SQL queries.
   * External code should prefer the typed methods (searchSymbol, callers, …). */
  readonly db: Database;
  private root: string | undefined;
  private lastIndexedAt: number | null = null;
  private opts: Required<Pick<CodegraphOptions, "maxFileKb" | "maxFiles">> & Pick<CodegraphOptions, "dataDir">;

  constructor(opts: CodegraphOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.opts = {
      maxFileKb: opts.maxFileKb ?? 256,
      maxFiles: opts.maxFiles ?? 4000,
      dataDir: opts.dataDir,
    };
    this.db = new Database(join(opts.dataDir, "codegraph.sqlite"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        language TEXT
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT,
        exported INTEGER NOT NULL DEFAULT 0,
        language TEXT
      );
      CREATE INDEX IF NOT EXISTS sym_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS sym_path ON symbols(path);
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ed_src ON edges(src);
      CREATE INDEX IF NOT EXISTS ed_dst ON edges(dst);
    `);
  }

  setRoot(root: string): void {
    this.root = root;
  }

  reset(): void {
    this.db.exec("DELETE FROM files; DELETE FROM symbols; DELETE FROM edges;");
    this.lastIndexedAt = null;
  }

  /** Walk a directory and index files incrementally. */
  async index(root: string): Promise<{ files: number; symbols: number; edges: number }> {
    this.setRoot(root);
    const files = collectFiles(root, this.opts.maxFiles, this.opts.maxFileKb * 1024);
    let sCount = 0;
    let eCount = 0;
    this.db.transaction(() => {
      for (const f of files) {
        if (shouldSkip(f)) continue;
        let text: string;
        try {
          const stat = statSync(f);
          if (!stat.isFile() || stat.size > this.opts.maxFileKb * 1024) continue;
          text = readFileSync(f, "utf8");
        } catch {
          continue;
        }
        const lang = detectLang(f) ?? "text";
        const sf = shortFile(f, root);
        const mtime = Math.floor(Date.now() / 1000);
        const size = text.length;
        this.db
          .query("INSERT OR REPLACE INTO files (path, mtime, size, language) VALUES (?, ?, ?, ?)")
          .run(sf, mtime, size, lang);
        this.db.query("DELETE FROM symbols WHERE path = ?").run(sf);
        const oldSymIds = this.db
          .query<{ id: string }, [string]>("SELECT id FROM symbols WHERE path = ?")
          .all(sf)
          .map((r) => r.id);
        if (oldSymIds.length) {
          const ph = oldSymIds.map(() => "?").join(",");
          this.db
            .query(`DELETE FROM edges WHERE src IN (${ph}) OR dst IN (${ph})`)
            .run(...oldSymIds, ...oldSymIds);
        }
        const { symbols, edges } = extractSymbolsAndEdges(sf, text, lang);
        sCount += symbols.length;
        eCount += edges.length;
        const insSym = this.db.query(
          "INSERT OR REPLACE INTO symbols (id, path, kind, name, line, end_line, signature, exported, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const s of symbols) {
          insSym.run(s.id, s.file, s.kind, s.name, s.line, s.endLine, s.signature ?? null, s.exported ? 1 : 0, s.language);
        }
        const insEdge = this.db.query(
          "INSERT INTO edges (src, dst, kind, line) VALUES (?, ?, ?, ?)",
        );
        for (const e of edges) {
          insEdge.run(e.src, e.dst, e.kind, e.line);
        }
      }
    })();
    this.lastIndexedAt = Date.now();
    return { files: files.length, symbols: sCount, edges: eCount };
  }

  searchSymbol(query: string, limit = 20): Symbol[] {
    const rows = this.db
      .query<Record<string, unknown>, [string, number]>(
        "SELECT * FROM symbols WHERE name LIKE ? ORDER BY name LIMIT ?",
      )
      .all(`%${query}%`, limit);
    return rows.map(rowToSymbol);
  }

  node(id: string): Symbol | undefined {
    const r = this.db.query("SELECT * FROM symbols WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? rowToSymbol(r) : undefined;
  }

  callers(symbolId: string, depth = 1): Symbol[] {
    if (depth <= 0) return [];
    const rows = this.db
      .query<Record<string, unknown>, [string]>(
        `SELECT DISTINCT s.* FROM edges e
         JOIN symbols s ON s.id = e.src
         WHERE e.dst = ? AND e.kind = 'call' LIMIT 50`,
      )
      .all(symbolId);
    const direct = rows.map(rowToSymbol);
    if (depth > 1) {
      const more: Symbol[] = [];
      for (const c of direct) more.push(...this.callers(c.id, depth - 1));
      return [...direct, ...more];
    }
    return direct;
  }

  callees(symbolId: string, depth = 1): Symbol[] {
    if (depth <= 0) return [];
    const rows = this.db
      .query<Record<string, unknown>, [string]>(
        `SELECT DISTINCT s.* FROM edges e
         JOIN symbols s ON s.id = e.dst
         WHERE e.src = ? AND e.kind = 'call' LIMIT 50`,
      )
      .all(symbolId);
    const direct = rows.map(rowToSymbol);
    if (depth > 1) {
      const more: Symbol[] = [];
      for (const c of direct) more.push(...this.callees(c.id, depth - 1));
      return [...direct, ...more];
    }
    return direct;
  }

  impact(symbolId: string): ImpactResult {
    const sym = this.node(symbolId);
    if (!sym) {
      return {
        symbol: { id: symbolId, file: "", kind: "function", name: "", line: 0, endLine: 0, exported: false, language: "?" },
        callers: [],
        callees: [],
        filesAffected: [],
        blastRadius: 0,
      };
    }
    const callers = this.callers(symbolId, 3);
    const callees = this.callees(symbolId, 2);
    const files = new Set<string>();
    files.add(sym.file);
    for (const c of callers) files.add(c.file);
    for (const c of callees) files.add(c.file);
    return {
      symbol: sym,
      callers,
      callees,
      filesAffected: [...files],
      blastRadius: callers.length,
    };
  }

  files(): string[] {
    return this.db
      .query<{ path: string }, []>("SELECT path FROM files ORDER BY path LIMIT 1000")
      .all()
      .map((r) => r.path);
  }

  stats(): CodegraphStats {
    const files = this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM files").get()?.c ?? 0;
    const symbols = this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM symbols").get()?.c ?? 0;
    const edges = this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM edges").get()?.c ?? 0;
    const langRows = this.db
      .query<{ language: string; c: number }, []>("SELECT language, COUNT(*) AS c FROM files GROUP BY language")
      .all();
    const languages: Record<string, number> = {};
    for (const r of langRows) languages[r.language] = r.c;
    return { files, symbols, edges, languages, lastIndexedAt: this.lastIndexedAt };
  }

  close(): void {
    this.db.close();
  }
}

function rowToSymbol(r: Record<string, unknown>): Symbol {
  return {
    id: r.id as string,
    file: r.path as string,
    kind: r.kind as Symbol["kind"],
    name: r.name as string,
    line: Number(r.line),
    endLine: Number(r.end_line),
    signature: r.signature as string | undefined,
    exported: Number(r.exported) === 1,
    language: (r.language as string) ?? "?",
    summary: r.summary as string | undefined,
  };
}

function collectFiles(root: string, max: number, maxBytes: number): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      if (shouldSkip(full)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && st.size > 0 && st.size <= maxBytes) {
        out.push(full);
      }
    }
  }
  return out;
}

function extractSymbolsAndEdges(file: string, text: string, lang: string): { symbols: Symbol[]; edges: Edge[] } {
  const symbols: Symbol[] = [];
  const edges: Edge[] = [];
  const lines = text.split(/\r?\n/);
  const symByName = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    for (const { re, kind } of SYMBOL_RE) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const name = m[1]!;
        const id = idFor(file, name, i + 1);
        if (!symByName.has(name)) symByName.set(name, id);
        symbols.push({
          id,
          file,
          kind: kind as Symbol["kind"],
          name,
          line: i + 1,
          endLine: i + 1,
          signature: line.trim().slice(0, 200),
          exported: /^\s*(?:export|pub)\b/i.test(line),
          language: lang,
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(line)) !== null) {
      const head = m[1]!;
      const method = m[2];
      const candidates = method ? [`${head}.${method}`, head] : [head];
      for (const c of candidates) {
        const target = symByName.get(c);
        if (target) {
          const src = [...symbols].reverse().find((s) => s.line <= i + 1 && s.file === file);
          if (src && src.id !== target) {
            edges.push({ src: src.id, dst: target, kind: "call", line: i + 1 });
          }
        }
      }
    }
  }

  return { symbols, edges };
}
