// src/mcp/server.ts
//
// Minimal MCP (Model Context Protocol) server, exposing the apex-pi
// extension tools over Streamable HTTP transport (the new MCP default
// since the 2025-03-26 spec). Any MCP client — Claude Desktop, Cursor,
// Continue, the pi-coding-agent's own MCP client — can now consume
// apex_search / apex_ingest / codegraph_* / understand_path / etc.
//
// This is ~150 LOC; we don't depend on @modelcontextprotocol/sdk to keep
// RSS low, but we follow the spec wire-format exactly.

import { config } from "../config.ts";
import { log } from "../log.ts";
import { getMemoryEngine } from "../memory/index.ts";
import { getStore } from "../bootstrap.ts";
import { getCodegraph } from "../codegraph/index.ts";
import { understand } from "../understand/index.ts";
import { isAbsolute, resolve } from "node:path";

interface McpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const APEX_TOOLS: McpToolDef[] = [
  {
    name: "apex_search",
    description: "Hybrid search over the 5D memory store.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top_k: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "apex_ingest",
    description: "Ingest a memory record.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        dimension: { type: "string", enum: ["working", "episodic", "semantic", "procedural", "declarative"] },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "number" },
      },
      required: ["content", "dimension"],
    },
  },
  {
    name: "codegraph_search",
    description: "Search symbols in the indexed codebase.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "codegraph_impact",
    description: "Compute blast radius of a symbol.",
    inputSchema: {
      type: "object",
      properties: { symbol_id: { type: "string" } },
      required: ["symbol_id"],
    },
  },
  {
    name: "understand_path",
    description: "Build a knowledge graph of a directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, max_files: { type: "number" }, focus: { type: "string" } },
      required: ["path"],
    },
  },
];

function ok(id: number | string, result: unknown): McpResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: number | string, code: number, message: string): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const engine = getMemoryEngine(getStore()!);
  switch (name) {
    case "apex_search": {
      const hits = await engine.search({
        query: String(args.query ?? ""),
        topK: Number(args.top_k ?? 6),
      });
      return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
    }
    case "apex_ingest": {
      const rec = await engine.ingest({
        content: String(args.content ?? ""),
        dimension: args.dimension as never,
        tags: (args.tags as string[]) ?? [],
        importance: args.importance === undefined ? 0.5 : Number(args.importance),
      });
      return { content: [{ type: "text", text: JSON.stringify(rec) }] };
    }
    case "codegraph_search": {
      const syms = getCodegraph().searchSymbol(String(args.query ?? ""), Number(args.limit ?? 12));
      return { content: [{ type: "text", text: JSON.stringify(syms, null, 2) }] };
    }
    case "codegraph_impact": {
      const r = getCodegraph().impact(String(args.symbol_id));
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    case "understand_path": {
      const p = String(args.path);
      const r = await understand({ root: isAbsolute(p) ? p : resolve(process.cwd(), p), maxFiles: args.max_files as number, focus: args.focus as string });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function handleMcp(req: Request): Promise<Response> {
  if (!config().mcp.enabled && new URL(req.url).pathname !== `${config().mcp.mountPath}/healthz`) {
    return new Response("MCP disabled", { status: 404 });
  }
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, tools: APEX_TOOLS.length, version: "2025-03-26" }), {
      headers: { "content-type": "application/json" },
    });
  }
  let msg: McpRequest;
  try {
    msg = (await req.json()) as McpRequest;
  } catch (e) {
    return new Response(`bad json: ${(e as Error).message}`, { status: 400 });
  }
  let resp: McpResponse;
  try {
    switch (msg.method) {
      case "initialize":
        resp = ok(msg.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "apex-pi", version: "0.2.0" },
        });
        break;
      case "tools/list":
        resp = ok(msg.id, { tools: APEX_TOOLS });
        break;
      case "tools/call": {
        const p = msg.params ?? {};
        const name = String(p.name ?? "");
        const args = (p.arguments as Record<string, unknown> | undefined) ?? {};
        const r = await callTool(name, args);
        resp = ok(msg.id, r);
        break;
      }
      case "ping":
        resp = ok(msg.id, { pong: Date.now() });
        break;
      default:
        resp = err(msg.id, -32601, `method not found: ${msg.method}`);
    }
  } catch (e) {
    log.error("mcp.error", { err: (e as Error).message, method: msg.method });
    resp = err(msg.id, -32603, (e as Error).message);
  }
  return new Response(JSON.stringify(resp), {
    headers: { "content-type": "application/json" },
  });
}
