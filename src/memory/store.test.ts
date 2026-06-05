// src/memory/store.test.ts — unit test for the in-process 5D memory engine.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";

let store: MemoryStore;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "apex-pi-mem-"));
  store = new MemoryStore({ path: join(dataDir, "mem.sqlite"), cap: 100, dedupThreshold: 0.92 });
});

afterAll(() => {
  store.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("ingest + get roundtrip", () => {
  const rec = store.ingest({ dimension: "semantic", content: "Bun is a fast JS runtime", tags: ["bun"] });
  expect(rec.id).toBeTruthy();
  expect(rec.dimension).toBe("semantic");
  const got = store.get(rec.id);
  expect(got?.content).toBe("Bun is a fast JS runtime");
});

test("dedup by hash bumps access", () => {
  const a = store.ingest({ dimension: "semantic", content: "unique dedup test xyzzy" });
  const b = store.ingest({ dimension: "semantic", content: "unique dedup test xyzzy" });
  expect(b.id).toBe(a.id);
  expect(b.accessCount).toBeGreaterThanOrEqual(1);
});

test("search returns BM25 hits", () => {
  store.ingest({ dimension: "semantic", content: "Rust language memory safety ownership borrowing" });
  store.ingest({ dimension: "episodic", content: "Yesterday the build broke because of a TypeScript error" });
  const hits = store.search({ query: "memory safety Rust", topK: 5 });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((h) => h.record.content.includes("Rust"))).toBe(true);
});

test("graph expansion finds related memories", () => {
  store.ingest({ dimension: "semantic", content: "ApexMem and BunSqlite and Codegraph all live in apex-pi" });
  const hits = store.search({ query: "ApexMem", topK: 5, expandGraph: true });
  expect(hits.length).toBeGreaterThan(0);
});

test("dream sweep decays and dedups", () => {
  // Add duplicates
  for (let i = 0; i < 3; i++) {
    store.ingest({ dimension: "procedural", content: "dream sweep fixture" });
  }
  const r = store.dream();
  expect(r.merged).toBeGreaterThanOrEqual(2);
  expect(r.decayed).toBeGreaterThanOrEqual(0);
});

test("stats + health", () => {
  const s = store.stats();
  expect(s.total).toBeGreaterThan(0);
  const h = store.health();
  expect(h.issues).toBeDefined();
  expect(typeof h.deltaG).toBe("number");
});
