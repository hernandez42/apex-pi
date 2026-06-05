// src/http/server.ts
//
// Hono HTTP server that exposes the apex-pi Agent over HTTP and SSE.
// All endpoints are JSON except /v1/chat (Server-Sent Events) and the
// /v1/mcp (MCP Streamable HTTP) endpoint.

import { Hono } from "hono";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { getAgent } from "../agent.ts";
import { getMemoryEngine } from "../memory/index.ts";
import { getStore } from "../bootstrap.ts";
import { getCodegraph } from "../codegraph/index.ts";
import { understand } from "../understand/index.ts";
import { isAbsolute, resolve } from "node:path";
import { systemPrompt } from "../skills/index.ts";
import { createFeishuMom } from "../channels/feishu.ts";
import { handleMcp } from "../mcp/server.ts";
import type { MemoryDimension } from "../memory/types.ts";

export function createApp(): Hono {
  const app = new Hono();
  const feishu = createFeishuMom({
    useCard: config().feishu.useCard,
    maxReplyChars: config().feishu.maxReplyChars,
  });

  // ─── diagnostics ────────────────────────────────────────────────────
  app.get("/healthz", (c) => c.json({ ok: true, version: "0.2.0", engine: "pi-agent-core" }));
  app.get("/readyz", async (c) => {
    // Bug #4 fix: don't assume `getStore()` is non-null. If `boot()` has
    // not been called (e.g. /readyz hit before the server's first
    // request triggers boot via the agent), we still want a clean 503
    // with a useful payload — not a TypeError crash.
    const store = getStore();
    if (!store) {
      return c.json({ ok: false, reason: "not booted" }, 503);
    }
    try {
      const stats = await getMemoryEngine(store).stats();
      return c.json({ ok: true, memory: stats });
    } catch (e) {
      return c.json({ ok: false, err: (e as Error).message }, 503);
    }
  });

  // ─── agent (SSE) ────────────────────────────────────────────────────
  app.post("/v1/chat", async (c) => {
    const body = await c.req.json<{
      message: string;
      system?: string;
      skills?: string[];
      session_id?: string;
    }>();
    if (!body.message) return c.json({ error: "message is required" }, 400);

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        // Bug #6 fix: capture `sub` in a `let` so the catch path can
        // unsubscribe. Previously, when `agent.prompt()` threw, the
        // function exited via the catch and the subscription leaked.
        let sub: (() => void) | null = null;
        try {
          const agent = getAgent();
          sub = agent.subscribe((ev: import("@earendil-works/pi-agent-core").AgentEvent) => {
            // Forward every relevant event; the client filters.
            send(ev.type, ev);
          });
          send("start", { ts: Date.now() });
          await agent.prompt(body.message);
          send("done", { ts: Date.now() });
        } catch (e) {
          send("error", { message: (e as Error).message });
        } finally {
          if (sub) sub();
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  });

  // Bug #4 helper: return 503 if the store is not yet open.
  const requireStore = (c: { json: (v: unknown, s?: number) => Response }) => {
    const s = getStore();
    if (!s) return { ok: false as const, res: c.json({ error: "store not booted" }, 503) };
    return { ok: true as const, store: s };
  };

  // ─── memory ─────────────────────────────────────────────────────────
  app.post("/v1/memories", async (c) => {
    const r = requireStore(c);
    if (!r.ok) return r.res;
    const body = await c.req.json();
    const rec = await getMemoryEngine(r.store).ingest(body);
    return c.json(rec);
  });
  app.post("/v1/memories/search", async (c) => {
    const r = requireStore(c);
    if (!r.ok) return r.res;
    const body = await c.req.json<{ query: string; top_k?: number }>();
    const hits = await getMemoryEngine(r.store).search({ query: body.query, topK: body.top_k ?? 8 });
    return c.json({ hits });
  });
  app.post("/v1/feedback", async (c) => {
    const r = requireStore(c);
    if (!r.ok) return r.res;
    const body = await c.req.json<{ verdict: "up" | "down" | "note"; comment?: string; dimension?: string }>();
    if (!body.verdict) return c.json({ error: "verdict is required" }, 400);
    // Bug #5 fix: validate `dimension` against the known set instead of
    // blindly casting. Unknown values fall back to the verdict-default
    // so callers can still pass garbage without crashing the engine.
    const VALID_DIMS = new Set<MemoryDimension>(["episodic", "semantic", "procedural", "declarative", "working"]);
    const defaultDim: MemoryDimension = body.verdict === "down" ? "procedural" : "semantic";
    const dim: MemoryDimension =
      body.dimension && (VALID_DIMS as Set<string>).has(body.dimension)
        ? (body.dimension as MemoryDimension)
        : defaultDim;
    const importance = body.verdict === "down" ? 0.9 : body.verdict === "up" ? 0.4 : 0.6;
    const tag = body.verdict === "down" ? "feedback:bad" : body.verdict === "up" ? "feedback:good" : "feedback:note";
    const rec = await getMemoryEngine(r.store).ingest({
      content: body.comment?.trim() || `(${body.verdict})`,
      dimension: dim,
      importance,
      tags: [tag],
    });
    return c.json(rec);
  });
  app.get("/v1/stats", async (c) => {
    const r = requireStore(c);
    if (!r.ok) return r.res;
    const engine = getMemoryEngine(r.store);
    const cg = getCodegraph();
    return c.json({
      engine: engine.mode(),
      memory: await engine.stats(),
      codegraph: cg.stats(),
      uptimeSec: Math.floor(process.uptime()),
    });
  });
  app.get("/v1/graph", async (c) => {
    const r = requireStore(c);
    if (!r.ok) return r.res;
    return c.json(await getMemoryEngine(r.store).graphJson());
  });

  // ─── codegraph ──────────────────────────────────────────────────────
  app.post("/v1/codegraph/index", async (c) => {
    const body = await c.req.json<{ path: string }>();
    const r = await getCodegraph().index(resolve(body.path));
    return c.json(r);
  });
  app.get("/v1/codegraph/search", (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? 12);
    return c.json({ symbols: getCodegraph().searchSymbol(q, limit) });
  });
  app.get("/v1/codegraph/impact", (c) => {
    const id = c.req.query("id");
    if (!id) return c.json({ error: "id is required" }, 400);
    return c.json(getCodegraph().impact(id));
  });

  // ─── understand ─────────────────────────────────────────────────────
  app.post("/v1/understand", async (c) => {
    const body = await c.req.json<{ path: string; max_files?: number; focus?: string }>();
    if (!body.path) return c.json({ error: "path is required" }, 400);
    const r = await understand({
      root: isAbsolute(body.path) ? body.path : resolve(body.path),
      maxFiles: body.max_files,
      focus: body.focus,
    });
    return c.json(r);
  });

  // ─── skills (built-in + SKILLS_DIR) ─────────────────────────────────
  app.get("/v1/skills", async (c) => {
    const { SKILLS } = await import("../skills/index.ts");
    return c.json({ names: Object.keys(SKILLS) });
  });
  app.post("/v1/system-prompt", async (c) => {
    const body = await c.req.json<{ skills?: string[]; customBase?: string }>();
    return c.json({ systemPrompt: systemPrompt(body) });
  });

  // ─── feishu webhook ────────────────────────────────────────────────
  app.post("/v1/feishu/webhook", (c) => feishu.handleWebhook(c.req.raw));

  // ─── MCP (Streamable HTTP) ─────────────────────────────────────────
  app.all(`${config().mcp.mountPath}/*`, (c) => handleMcp(c.req.raw));
  app.all(config().mcp.mountPath, (c) => handleMcp(c.req.raw));

  return app;
}
