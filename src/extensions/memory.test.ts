// src/extensions/memory.test.ts — verifies apex_* tool schemas and
// end-to-end behaviour against a real MemoryStore.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHost } from "./host.ts";
import { installApexExtensions } from "./index.ts";
import { boot, shutdown, getStore } from "../bootstrap.ts";
import { getMemoryEngine } from "../memory/index.ts";
import { resetConfigForTests } from "../config.ts";
import { setStoreForMemoryEngine } from "../memory/bridge.ts";

let dataDir: string;

beforeAll(() => {
  process.env.APEX_PI_DATA = mkdtempSync(join(tmpdir(), "apex-pi-ext-"));
  process.env.SKILLS_DIR = process.env.APEX_PI_DATA;
  resetConfigForTests();
  dataDir = process.env.APEX_PI_DATA;
  const store = boot().store;
  setStoreForMemoryEngine(store);
});

afterAll(() => {
  shutdown();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("installApexExtensions registers apex_* tools", () => {
  const h = createExtensionHost();
  installApexExtensions(h);
  const names = h.tools().map((t) => t.name);
  // 4 core tools (bash, read, write, edit) + 7 apex_* + 4 codegraph_* + 1 understand
  expect(names).toContain("bash");
  expect(names).toContain("read");
  expect(names).toContain("write");
  expect(names).toContain("edit");
  expect(names).toContain("apex_search");
  expect(names).toContain("apex_ingest");
  expect(names).toContain("apex_relate");
  expect(names).toContain("apex_stats");
  expect(names).toContain("apex_feedback");
  expect(names).toContain("apex_distill");
  expect(names).toContain("apex_list_skills");
  expect(names).toContain("codegraph_search");
  expect(names).toContain("codegraph_callers");
  expect(names).toContain("codegraph_callees");
  expect(names).toContain("codegraph_impact");
  expect(names).toContain("understand_path");
});

test("apex_ingest tool stores a record", async () => {
  const h = createExtensionHost();
  installApexExtensions(h);
  const tool = h.tools().find((t) => t.name === "apex_ingest")!;
  const res = await tool.execute("call_test", { content: "hello test world", dimension: "semantic" }, undefined, undefined);
  expect((res as { isError?: boolean }).isError).toBeFalsy();
  const engine = getMemoryEngine(getStore()!);
  const hits = await engine.search({ query: "hello test", topK: 1 });
  expect(hits[0]!.record.content).toBe("hello test world");
});

test("apex_feedback tags with feedback:* and bumps importance", async () => {
  const h = createExtensionHost();
  installApexExtensions(h);
  const tool = h.tools().find((t) => t.name === "apex_feedback")!;
  await tool.execute("c1", { verdict: "down", comment: "this was wrong" }, undefined, undefined);
  const engine = getMemoryEngine(getStore()!);
  const hits = await engine.search({ query: "wrong", topK: 1 });
  expect(hits[0]!.record.tags).toContain("feedback:bad");
  expect(hits[0]!.record.dimension).toBe("procedural");
  expect(hits[0]!.record.importance).toBeGreaterThan(0.5);
});
