// src/codegraph/store.test.ts — unit test for the codegraph SQLite engine.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codegraph } from "./store.ts";

let cg: Codegraph;
let dataDir: string;
let repoDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "apex-pi-cg-data-"));
  repoDir = mkdtempSync(join(tmpdir(), "apex-pi-cg-repo-"));
  cg = new Codegraph({ dataDir });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "main.ts"), `export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return add(a, -b); }\nsub(1, 2);\nadd(3, 4);\n`);
  writeFileSync(join(repoDir, "src", "util.ts"), `export class Greeter { greet(name: string) { return \`hi \${name}\`; } }\n`);
  await cg.index(repoDir);
});

afterAll(() => {
  cg.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("indexes symbols", () => {
  const stats = cg.stats();
  expect(stats.symbols).toBeGreaterThan(0);
  expect(stats.files).toBeGreaterThanOrEqual(2);
  expect(stats.languages.typescript).toBeGreaterThan(0);
});

test("searchSymbol finds by name", () => {
  const hits = cg.searchSymbol("add", 10);
  expect(hits.some((h) => h.name === "add")).toBe(true);
});

test("callers finds the call site", () => {
  const addHits = cg.searchSymbol("add", 5);
  const addId = addHits.find((h) => h.name === "add")?.id;
  expect(addId).toBeTruthy();
  const callers = cg.callers(addId!, 1);
  expect(callers.some((c) => c.name === "sub")).toBe(true);
});

test("impact computes blast radius", () => {
  const addHits = cg.searchSymbol("add", 5);
  const addId = addHits.find((h) => h.name === "add")?.id;
  const r = cg.impact(addId!);
  expect(r.symbol.name).toBe("add");
  expect(r.blastRadius).toBeGreaterThan(0);
  expect(r.callers.some((c) => c.name === "sub")).toBe(true);
});
