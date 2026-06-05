// src/extensions/codegraph.ts
// Registers 4 codegraph_* tools with the agent host.

import { Type } from "typebox";
import { getCodegraph, type Codegraph } from "../codegraph/index.ts";
import type { ApexExtensionAPI } from "./host.ts";

function getCg(): Codegraph {
  return getCodegraph();
}

export function registerCodegraphTools(api: ApexExtensionAPI): void {
  api.registerTool({
    name: "codegraph_search",
    label: "Codegraph Search",
    description:
      "Fuzzy search for a symbol by name across the indexed codebase. Returns up to 20 hits with file/line/kind.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 12 })),
    }),
    async execute(_id, params) {
      const hits = getCg().searchSymbol(String(params.query ?? ""), Number(params.limit ?? 12));
      if (!hits.length) return { content: [{ type: "text", text: "(no symbols matched)" }], details: { count: 0 } };
      const text = hits
        .map((s) => `${s.kind} ${s.name} — ${s.file}:${s.line}${s.exported ? " [exported]" : ""}`)
        .join("\n");
      return { content: [{ type: "text", text }], details: { count: hits.length } };
    },
  });

  api.registerTool({
    name: "codegraph_callers",
    label: "Codegraph Callers",
    description: "Find all symbols that call the given symbol id (e.g. src/foo.ts::bar@42).",
    parameters: Type.Object({
      symbol_id: Type.String(),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 1 })),
    }),
    async execute(_id, params) {
      const syms = getCg().callers(String(params.symbol_id), Number(params.depth ?? 1));
      if (!syms.length) return { content: [{ type: "text", text: "(no callers)" }], details: { count: 0 } };
      const text = syms.map((s) => `${s.kind} ${s.name} — ${s.file}:${s.line}`).join("\n");
      return { content: [{ type: "text", text }], details: { count: syms.length } };
    },
  });

  api.registerTool({
    name: "codegraph_callees",
    label: "Codegraph Callees",
    description: "Find all symbols called by the given symbol id.",
    parameters: Type.Object({
      symbol_id: Type.String(),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 1 })),
    }),
    async execute(_id, params) {
      const syms = getCg().callees(String(params.symbol_id), Number(params.depth ?? 1));
      if (!syms.length) return { content: [{ type: "text", text: "(no callees)" }], details: { count: 0 } };
      const text = syms.map((s) => `${s.kind} ${s.name} — ${s.file}:${s.line}`).join("\n");
      return { content: [{ type: "text", text }], details: { count: syms.length } };
    },
  });

  api.registerTool({
    name: "codegraph_impact",
    label: "Codegraph Impact",
    description:
      "Compute the blast radius of changing a symbol: transitive callers + callees + files affected.",
    parameters: Type.Object({ symbol_id: Type.String() }),
    async execute(_id, params) {
      const r = getCg().impact(String(params.symbol_id));
      if (!r.symbol.name) {
        return { content: [{ type: "text", text: "symbol not found" }], details: { error: "not_found" }, isError: true };
      }
      const text = `symbol: ${r.symbol.kind} ${r.symbol.name} (${r.symbol.file}:${r.symbol.line})
blast radius: ${r.blastRadius}
files affected: ${r.filesAffected.length}
callers (${r.callers.length}): ${r.callers.slice(0, 10).map((s) => s.name).join(", ")}
callees (${r.callees.length}): ${r.callees.slice(0, 10).map((s) => s.name).join(", ")}`;
      return { content: [{ type: "text", text }], details: { blastRadius: r.blastRadius, files: r.filesAffected.length } };
    },
  });
}
