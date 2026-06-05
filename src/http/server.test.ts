// src/http/server.test.ts — end-to-end test of the HTTP API.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "../config.ts";
import { boot, shutdown, getStore } from "../bootstrap.ts";
import { getMemoryEngine } from "../memory/index.ts";
import { createApp } from "./server.ts";

let dataDir: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  process.env.APEX_PI_DATA = mkdtempSync(join(tmpdir(), "apex-pi-http-"));
  process.env.LLM_PROVIDER = "openai";
  process.env.LLM_MODEL = "gpt-4o-mini";
  process.env.LLM_API_KEY = "test-key";
  process.env.MCP_ENABLED = "1";
  process.env.FEISHU_ENABLED = "0";
  resetConfigForTests();
  dataDir = process.env.APEX_PI_DATA!;
  boot();
  const app = createApp();
  server = Bun.serve({ port: 0, fetch: app.fetch });
});

afterAll(() => {
  server.stop();
  shutdown();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("GET /healthz", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
  expect(res.status).toBe(200);
  const j = await res.json() as { ok: boolean; version: string };
  expect(j.ok).toBe(true);
  expect(j.version).toBeTruthy();
});

test("GET /readyz reports memory stats", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
  expect(res.status).toBe(200);
  const j = await res.json() as { ok: boolean; memory: { total: number } };
  expect(j.ok).toBe(true);
  expect(j.memory).toBeDefined();
});

test("POST /v1/memories + POST /v1/memories/search roundtrip", async () => {
  const inRes = await fetch(`http://127.0.0.1:${server.port}/v1/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "HTTP integration test memory", dimension: "semantic", tags: ["test"] }),
  });
  expect(inRes.status).toBe(200);
  const rec = await inRes.json() as { id: string; content: string };
  expect(rec.content).toBe("HTTP integration test memory");

  const sRes = await fetch(`http://127.0.0.1:${server.port}/v1/memories/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "integration test" }),
  });
  expect(sRes.status).toBe(200);
  const sJ = await sRes.json() as { hits: Array<{ record: { id: string } }> };
  expect(sJ.hits.some((h) => h.record.id === rec.id)).toBe(true);
});

test("POST /v1/feedback ingests tagged record", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict: "down", comment: "broken" }),
  });
  expect(res.status).toBe(200);
  const engine = getMemoryEngine(getStore()!);
  const hits = await engine.search({ query: "broken", topK: 1 });
  expect(hits[0]!.record.tags).toContain("feedback:bad");
});

test("POST /v1/feedback with unknown dimension falls back to verdict-default (Bug #5)", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict: "down", comment: "garbage dim", dimension: "mythical" }),
  });
  expect(res.status).toBe(200);
  const engine = getMemoryEngine(getStore()!);
  const hits = await engine.search({ query: "garbage dim", topK: 1 });
  // 'down' verdict defaults to 'procedural' when dimension is invalid.
  expect(hits[0]!.record.dimension).toBe("procedural");
});

test("POST /v1/feedback with valid dimension honours it (Bug #5)", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verdict: "up", comment: "episodic test", dimension: "episodic" }),
  });
  expect(res.status).toBe(200);
  const engine = getMemoryEngine(getStore()!);
  const hits = await engine.search({ query: "episodic test", topK: 1 });
  expect(hits[0]!.record.dimension).toBe("episodic");
});

test("GET /v1/skills lists built-in + loaded", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/v1/skills`);
  expect(res.status).toBe(200);
  const j = await res.json() as { names: string[] };
  expect(j.names).toContain("brainstorm");
});

test("GET /mcp discovery returns tool list", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`);
  expect(res.status).toBe(200);
  const j = await res.json() as { tools: number; version: string };
  expect(j.tools).toBeGreaterThan(0);
  expect(j.version).toBe("2025-03-26");
});

test("POST /mcp initialize returns serverInfo", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  expect(res.status).toBe(200);
  const j = await res.json() as { result: { serverInfo: { name: string } } };
  expect(j.result.serverInfo.name).toBe("apex-pi");
});

test("POST /mcp tools/list returns apex_search", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const j = await res.json() as { result: { tools: Array<{ name: string }> } };
  const names = j.result.tools.map((t) => t.name);
  expect(names).toContain("apex_search");
  expect(names).toContain("understand_path");
});

test("POST /mcp tools/call apex_search returns content block", async () => {
  // Seed a memory first.
  await fetch(`http://127.0.0.1:${server.port}/v1/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "MCP integration test fixture", dimension: "semantic" }),
  });
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "apex_search", arguments: { query: "MCP integration fixture" } },
    }),
  });
  const j = await res.json() as { result: { content: Array<{ type: string; text: string }> } };
  expect(j.result.content[0]!.type).toBe("text");
  expect(j.result.content[0]!.text).toContain("MCP integration test fixture");
});
