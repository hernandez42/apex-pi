// src/extensions/understand.ts
// Registers the understand_path tool — 5-phase codebase graph that runs
// scanner → analyzer → tours → hotspots → LLM explainer.

import { Type, type Static } from "typebox";
import { isAbsolute, resolve } from "node:path";
import { understand } from "../understand/index.ts";
import { config } from "../config.ts";
import type { ApexExtensionAPI } from "./host.ts";

const UnderstandParams = Type.Object({
  path: Type.String({ description: "Absolute path to a directory." }),
  max_files: Type.Optional(Type.Integer({ minimum: 1, maximum: 50_000 })),
  focus: Type.Optional(Type.String({ description: "Optional focus question for the explainer." })),
  graph_only: Type.Optional(Type.Boolean({ default: false })),
});

export function registerUnderstandTool(api: ApexExtensionAPI): void {
  void api; // currently no host events to subscribe to
  api.registerTool({
    name: "understand_path",
    label: "Understand Path",
    description:
      "Build a knowledge graph of a directory and return an LLM-written architectural summary + guided tours + hotspots. Pass graph_only=true to skip the LLM call and get a pure deterministic graph.",
    parameters: UnderstandParams,
    async execute(_id, params: Static<typeof UnderstandParams>) {
      const p = String(params.path ?? "");
      if (!p) return { content: [{ type: "text", text: "path is required" }], details: { error: "no_path", scanned: undefined, symbols: undefined } as any, isError: true };
      const root = isAbsolute(p) ? p : resolve(process.cwd(), p);
      const r = await understand({
        root,
        maxFiles: Number(params.max_files ?? config().codegraph.maxFiles),
        focus: params.focus as string | undefined,
        graphOnly: Boolean(params.graph_only),
      });
      const text = `# Summary\n${r.summary}\n\n# Hotspots\n${r.hotspots.map((h) => `- ${h.file} (${h.symbols} symbols, ${h.exports} exports)`).join("\n")}\n\n# Tours\n${r.tours.map((t) => `## ${t.title}\n${t.steps.map((s) => `- ${s.symbol} @ ${s.file}:${s.line}`).join("\n")}`).join("\n")}`;
      return { content: [{ type: "text", text }], details: { error: undefined, scanned: r.scanned, symbols: r.symbols } as any };
    },
  });
}
