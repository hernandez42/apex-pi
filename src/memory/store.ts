// src/memory/store.ts
// In-process 5D memory engine using bun:sqlite (no native compile, no deps).
// Storage layout:
//   memories(id, dimension, content, tags, importance, created_at, accessed_at,
//            access_count, decay_until, hash, meta)
//   memories_fts  : FTS5(content, tags)
//   graph_nodes(id, kind, label)
//   graph_edges(src, rel, dst, weight, dim)

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tokenize } from "../json.ts";
import { log } from "../log.ts";
import {
  DEFAULT_DECAY_MS,
  type IngestInput,
  type MemoryDimension,
  type MemoryHealth,
  type MemoryHit,
  type MemoryRecord,
  type MemoryStats,
  type SearchInput,
} from "./types.ts";

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function uuid(): string {
  return crypto.randomUUID();
}

function rowToRecord(r: Record<string, unknown>): MemoryRecord {
  return {
    id: r.id as string,
    dimension: r.dimension as MemoryDimension,
    content: r.content as string,
    tags: JSON.parse((r.tags as string) || "[]"),
    importance: Number(r.importance ?? 0.5),
    createdAt: Number(r.created_at),
    accessedAt: Number(r.accessed_at),
    accessCount: Number(r.access_count ?? 0),
    decayUntil: Number(r.decay_until),
    hash: r.hash as string,
    meta: r.meta ? (JSON.parse(r.meta as string) as Record<string, unknown>) : undefined,
  };
}

export interface StoreOptions {
  path: string;
  cap: number;
  dedupThreshold: number;
}

export class MemoryStore {
  private db: Database;
  private cap: number;
  private dedupThreshold: number;
  private lastDreamAt: number | null = null;
  private listeners = new Set<() => void>();

  constructor(opts: StoreOptions) {
    mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new Database(opts.path, { create: true });
    this.cap = opts.cap;
    this.dedupThreshold = opts.dedupThreshold;
    this.init();
  }

  private init(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA temp_store = MEMORY;");
    this.db.exec("PRAGMA mmap_size = 8388608;"); // 8 MB
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        dimension TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        decay_until INTEGER NOT NULL,
        hash TEXT NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS mem_dim ON memories(dimension);
      CREATE INDEX IF NOT EXISTS mem_hash ON memories(hash);
      CREATE INDEX IF NOT EXISTS mem_decay ON memories(decay_until);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, tags, content='memories', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gn_label ON graph_nodes(label);

      CREATE TABLE IF NOT EXISTS graph_edges (
        src TEXT NOT NULL,
        rel TEXT NOT NULL,
        dst TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        dim TEXT,
        PRIMARY KEY(src, rel, dst)
      );
      CREATE INDEX IF NOT EXISTS ge_dst ON graph_edges(dst);

      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);

    // FTS triggers
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
    `);
  }

  close(): void {
    this.db.close();
  }

  on(ev: "change", fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    }
  }

  ingest(input: IngestInput): MemoryRecord {
    const now = Date.now();
    const dim = input.dimension;
    const content = input.content.trim();
    if (!content) throw new Error("content is empty");
    const hash = sha1(content.toLowerCase());
    const tags = input.tags ?? [];
    const importance = Math.max(0, Math.min(1, input.importance ?? 0.5));
    const decay = DEFAULT_DECAY_MS[dim];

    // dedup check (same hash) -> bump access
    const existing = this.db
      .query<{ id: string }, [string]>("SELECT id FROM memories WHERE hash = ? LIMIT 1")
      .get(hash);
    if (existing) {
      this.db
        .query("UPDATE memories SET accessed_at = ?, access_count = access_count + 1, importance = MAX(importance, ?) WHERE id = ?")
        .run(now, importance, existing.id);
      const rec = this.get(existing.id);
      this.emit();
      return rec!;
    }

    // cap per dimension
    const count = this.db
      .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM memories WHERE dimension = ?")
      .get(dim)?.c ?? 0;
    if (count >= this.cap) {
      // evict the lowest-importance, oldest-accessed record of this dimension
      this.db
        .query(
          "DELETE FROM memories WHERE id = (SELECT id FROM memories WHERE dimension = ? ORDER BY importance ASC, accessed_at ASC LIMIT 1)",
        )
        .run(dim);
    }

    const id = input.id ?? uuid();
    const record: MemoryRecord = {
      id,
      dimension: dim,
      content,
      tags,
      importance,
      createdAt: now,
      accessedAt: now,
      accessCount: 0,
      decayUntil: now + decay,
      hash,
      meta: input.meta,
    };
    this.db
      .query(
        `INSERT INTO memories (id, dimension, content, tags, importance, created_at, accessed_at, access_count, decay_until, hash, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        dim,
        content,
        JSON.stringify(tags),
        importance,
        record.createdAt,
        record.accessedAt,
        record.accessCount,
        record.decayUntil,
        hash,
        record.meta ? JSON.stringify(record.meta) : null,
      );

    // extract naive entities & relations to seed the graph
    this.indexEntitiesAndRelations(record);

    this.emit();
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    const r = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? rowToRecord(r) : undefined;
  }

  delete(id: string): boolean {
    const info = this.db.query("DELETE FROM memories WHERE id = ?").run(id);
    this.emit();
    return info.changes > 0;
  }

  /** Naive entity/relation extraction: pick CamelCase / snake_case tokens and
   * connect them as a soft "related_to" edge. Cheap but surprisingly useful
   * for the "graph BFS expansion" path of retrieval. */
  private indexEntitiesAndRelations(rec: MemoryRecord): void {
    const tokens = Array.from(
      new Set(
        (rec.content.match(/\b[A-Z][A-Za-z0-9_]{1,40}\b|\b[a-z]+_[a-z_]+\b/g) ?? []).map((t) =>
          t.toLowerCase(),
        ),
      ),
    ).slice(0, 12);
    if (tokens.length === 0) return;

    const insertNode = this.db.query(
      "INSERT OR IGNORE INTO graph_nodes (id, kind, label) VALUES (?, 'concept', ?)",
    );
    for (const t of tokens) {
      insertNode.run(t, t);
    }
    const insertEdge = this.db.query(
      "INSERT OR REPLACE INTO graph_edges (src, rel, dst, weight, dim) VALUES (?, 'related_to', ?, ?, ?)",
    );
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        insertEdge.run(tokens[i]!, tokens[j]!, 1.0, rec.dimension);
      }
    }
  }

  search(input: SearchInput): MemoryHit[] {
    const q = input.query.trim();
    if (!q) return [];
    const topK = input.topK ?? 8;
    const dims = input.dimensions ?? (["working", "episodic", "semantic", "procedural", "declarative"] as MemoryDimension[]);
    const placeholders = dims.map(() => "?").join(",");
    const now = Date.now();

    // 1. BM25 via FTS5
    const bm25Rows = this.db
      .query<{ id: string; bm25: number; rowid: number }, [string, ...(string | number)[]]>(
        `SELECT m.id, bm25(memories_fts) AS bm25, m.rowid
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.dimension IN (${placeholders})
         ORDER BY bm25(memories_fts)
         LIMIT ?`,
      )
      .all(this.fixFtsQuery(q), ...dims, topK * 4);

    // 2. Graph expansion: pick entities from the query, find neighbours
    const expand = input.expandGraph !== false;
    const expandDepth = Math.max(1, Math.min(3, input.expandDepth ?? 1));
    const queryTokens = Array.from(new Set(tokenize(q)));
    const graphIds = new Set<string>();
    if (expand && queryTokens.length) {
      const nodes = this.db
        .query<{ id: string }, [string]>(
          `SELECT id FROM graph_nodes WHERE id LIKE ? LIMIT 20`,
        )
        .all(`%${queryTokens[0]!.toLowerCase()}%`);
      for (const n of nodes) graphIds.add(n.id);
      // BFS up to expandDepth
      let frontier = [...graphIds];
      const seen = new Set<string>(graphIds);
      for (let d = 0; d < expandDepth; d++) {
        if (frontier.length === 0) break;
        const ph = frontier.map(() => "?").join(",");
        const next = this.db
          .query<{ src: string; dst: string }, string[]>(
            `SELECT src, dst FROM graph_edges WHERE src IN (${ph}) OR dst IN (${ph})`,
          )
          .all(...frontier, ...frontier);
        frontier = [];
        for (const e of next) {
          for (const id of [e.src, e.dst]) {
            if (!seen.has(id)) {
              seen.add(id);
              frontier.push(id);
            }
          }
        }
      }
      // Resolve neighbour ids back to memory rows that mention them
      for (const tok of seen) {
        const rows = this.db
          .query<{ id: string }, [string, string, ...string[]]>(
            `SELECT id FROM memories WHERE (content LIKE ? OR tags LIKE ?) AND dimension IN (${placeholders}) LIMIT 5`,
          )
          .all(`%${tok}%`, `%${tok}%`, ...dims);
        for (const r of rows) graphIds.add(r.id);
      }
    }

    // 3. Lexical rerank (Jaccard on tokens)
    const qSet = new Set(queryTokens);
    function jaccard(text: string): number {
      const t = new Set(tokenize(text));
      if (!t.size) return 0;
      let inter = 0;
      for (const x of qSet) if (t.has(x)) inter++;
      return inter / (t.size + qSet.size - inter);
    }

    // Merge results
    type Scored = { id: string; bm25: number; graph: number; lex: number; recency: number };
    const merged = new Map<string, Scored>();

    for (const r of bm25Rows) {
      const prev = merged.get(r.id) ?? { id: r.id, bm25: 0, graph: 0, lex: 0, recency: 0 };
      prev.bm25 = -r.bm25; // bm25() returns negative (lower = better); flip to positive
      merged.set(r.id, prev);
    }
    for (const id of graphIds) {
      const prev = merged.get(id) ?? { id, bm25: 0, graph: 0, lex: 0, recency: 0 };
      prev.graph = 1;
      merged.set(id, prev);
    }
    // Add recency/lex as post-filter by loading the rows
    for (const id of merged.keys()) {
      const rec = this.get(id);
      if (!rec) continue;
      const e = merged.get(id)!;
      e.lex = jaccard(rec.content);
      const ageDays = (now - rec.createdAt) / 86_400_000;
      e.recency = Math.exp(-ageDays / 30);
    }

    // RRF fusion: each source contributes 1/(k+rank)
    const k = 60;
    const sources = ["bm25", "graph", "lexical", "recency"] as const;
    const ranks = new Map<typeof sources[number], Map<string, number>>();
    for (const s of sources) ranks.set(s, new Map());
    for (const s of sources) {
      const sorted = [...merged.values()]
        .filter((v) => v[s] > 0)
        .sort((a, b) => b[s] - a[s]);
      sorted.forEach((v, i) => ranks.get(s)!.set(v.id, i + 1));
    }
    const scored: MemoryHit[] = [];
    for (const v of merged.values()) {
      let rrf = 0;
      const hits: MemoryHit["sources"] = [];
      for (const s of sources) {
        const r = ranks.get(s)!.get(v.id);
        if (r) {
          rrf += 1 / (k + r);
          hits.push(s);
        }
      }
      const rec = this.get(v.id);
      if (rec) scored.push({ record: rec, score: rrf, sources: hits });
    }
    scored.sort((a, b) => b.score - a.score);

    // Update access stats for the top hits (recency boost)
    for (const h of scored.slice(0, topK)) {
      this.touch(h.record.id);
    }
    return scored.slice(0, topK);
  }

  private touch(id: string): void {
    this.db
      .query("UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?")
      .run(Date.now(), id);
  }

  private fixFtsQuery(q: string): string {
    // strip non-alphanumerics and quote each token (FTS5 prefix-friendly)
    const parts = q
      .replace(/[^\p{L}\p{N}\s_]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .map((t) => `${t}*`);
    return parts.join(" ") || '""';
  }

  stats(): MemoryStats {
    const total = this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memories").get()?.c ?? 0;
    const byDim = {} as Record<MemoryDimension, number>;
    for (const d of ["working", "episodic", "semantic", "procedural", "declarative"] as MemoryDimension[]) {
      byDim[d] =
        this.db
          .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM memories WHERE dimension = ?")
          .get(d)?.c ?? 0;
    }
    const graphNodes = this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM graph_nodes").get()?.c ?? 0;
    const graphEdges = this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM graph_edges").get()?.c ?? 0;
    return {
      total,
      byDimension: byDim,
      graphNodes,
      graphEdges,
      ftsSize: total,
      lastDreamAt: this.lastDreamAt,
    };
  }

  health(): MemoryHealth {
    const stats = this.stats();
    const dups =
      this.db
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM (SELECT hash FROM memories GROUP BY hash HAVING COUNT(*) > 1)")
        .get()?.c ?? 0;
    const dangling =
      this.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) AS c FROM graph_edges e WHERE NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.id = e.src) OR NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.id = e.dst)",
        )
        .get()?.c ?? 0;
    const workingBloat = stats.byDimension.working > Math.max(64, this.cap * 0.1) ? 1 : 0;
    const issues: string[] = [];
    if (dups > 0) issues.push(`${dups} duplicate memory group(s)`);
    if (dangling > 0) issues.push(`${dangling} dangling graph edge(s)`);
    if (workingBloat) issues.push("working memory is bloated");
    const decayIssues = this.db
      .query<{ c: number }, [number]>("SELECT COUNT(*) AS c FROM memories WHERE decay_until < ?")
      .get(Date.now())?.c ?? 0;
    if (decayIssues > 0) issues.push(`${decayIssues} decayed memory record(s)`);
    const denom = Math.max(1, stats.total);
    const penalty = (dups + dangling + workingBloat + decayIssues) / denom;
    return {
      total: stats.total,
      duplicates: dups,
      missingEmbeddings: 0, // we don't use embeddings in the lightweight engine
      danglingEdges: dangling,
      workingBloat,
      deltaG: Math.max(-1, 1 - 2 * penalty),
      issues,
    };
  }

  /** Dreaming sweep: decay, dedup, promote, relation discovery. */
  dream(opts: { mergeThreshold?: number; promoteThreshold?: number } = {}): {
    decayed: number;
    merged: number;
    promoted: number;
  } {
    const now = Date.now();
    let decayed = 0;
    let merged = 0;
    let promoted = 0;

    // 1. Decay: shrink importance based on time since last access.
    this.db.transaction(() => {
      const rows = this.db
        .query<{ id: string; accessed_at: number; importance: number; dimension: string; access_count: number; decay_until: number }, []>(
          "SELECT id, accessed_at, importance, dimension, access_count, decay_until FROM memories",
        )
        .all();
      const upd = this.db.query(
        "UPDATE memories SET importance = ? WHERE id = ?",
      );
      for (const r of rows) {
        const ageDays = (now - r.accessed_at) / 86_400_000;
        const newImportance = r.importance * Math.exp(-ageDays / 30);
        if (Math.abs(newImportance - r.importance) > 0.001) {
          upd.run(newImportance, r.id);
          decayed++;
        }
      }

      // 2. Dedup: collapse exact-hash duplicates
      const dupGroups = this.db
        .query<{ hash: string; n: number; first_id: string }, []>(
          "SELECT hash, COUNT(*) AS n, MIN(id) AS first_id FROM memories GROUP BY hash HAVING n > 1",
        )
        .all();
      const delDup = this.db.query("DELETE FROM memories WHERE hash = ? AND id != ?");
      for (const g of dupGroups) {
        delDup.run(g.hash, g.first_id);
        merged += g.n - 1;
      }

      // 3. Promote: working with importance > threshold and access_count > 2 → semantic
      const promoteThreshold = opts.promoteThreshold ?? 0.55;
      const promoteRes = this.db
        .query("UPDATE memories SET dimension = 'semantic' WHERE dimension = 'working' AND importance > ? AND access_count > 2")
        .run(promoteThreshold);
      promoted = promoteRes.changes;
    })();

    this.lastDreamAt = now;
    this.emit();
    log.info("memory.dream.done", { decayed, merged, promoted });
    return { decayed, merged, promoted };
  }

  /** Add a typed graph edge between two entity labels. */
  relate(src: string, rel: string, dst: string, weight = 1.0, dim?: MemoryDimension): void {
    this.db
      .query("INSERT OR REPLACE INTO graph_nodes (id, kind, label) VALUES (?, 'concept', ?)")
      .run(src, src);
    this.db
      .query("INSERT OR REPLACE INTO graph_nodes (id, kind, label) VALUES (?, 'concept', ?)")
      .run(dst, dst);
    this.db
      .query(
        "INSERT OR REPLACE INTO graph_edges (src, rel, dst, weight, dim) VALUES (?, ?, ?, ?, ?)",
      )
      .run(src, rel, dst, weight, dim ?? null);
    this.emit();
  }

  /** Get graph in a Cytoscape-friendly JSON format. */
  graphJson(): { nodes: Array<{ data: { id: string; label: string } }>; edges: Array<{ data: { id: string; source: string; target: string; label: string } }> } {
    const nodes = this.db
      .query<{ id: string; label: string }, []>("SELECT id, label FROM graph_nodes LIMIT 500")
      .all()
      .map((n) => ({ data: { id: n.id, label: n.label } }));
    const edges = this.db
      .query<{ src: string; rel: string; dst: string }, []>("SELECT src, rel, dst FROM graph_edges LIMIT 1500")
      .all()
      .map((e) => ({ data: { id: `${e.src}->${e.dst}`, source: e.src, target: e.dst, label: e.rel } }));
    return { nodes, edges };
  }

  /** Heuristic extraction of facts from a block of chat text.
   *  Lines starting with `*`, `!`, `?` become task / decision / question records. */
  flushFromConversation(text: string, source = "session"): { extracted: MemoryRecord[] } {
    const lines = text.split(/\r?\n/);
    const extracted: MemoryRecord[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("*")) {
        extracted.push(this.ingest({ dimension: "procedural", content: t.slice(1).trim(), tags: [source], importance: 0.6 }));
      } else if (t.startsWith("!")) {
        extracted.push(this.ingest({ dimension: "declarative", content: t.slice(1).trim(), tags: [source], importance: 0.8 }));
      } else if (t.startsWith("?")) {
        extracted.push(this.ingest({ dimension: "episodic", content: t.slice(1).trim(), tags: [source, "question"], importance: 0.4 }));
      } else if (t.length > 32 && t.length < 240) {
        // soft declarative ingest
        extracted.push(this.ingest({ dimension: "semantic", content: t, tags: [source], importance: 0.5 }));
      }
    }
    return { extracted };
  }

  getDatabasePath(): string {
    // helper for debugging / fly volume mount
    return (this.db as unknown as { path?: string }).path ?? ":memory:";
  }
}

export function openMemoryStore(opts: { dataDir: string; cap: number; dedupThreshold: number }): MemoryStore {
  return new MemoryStore({ path: join(opts.dataDir, "apex-mem.sqlite"), ...opts });
}
