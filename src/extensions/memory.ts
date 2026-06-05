// src/extensions/memory.ts
// Registers 6 apex_* tools with the agent host:
//   apex_search, apex_ingest, apex_relate, apex_stats,
//   apex_feedback (natural-language learning), apex_distill (skill synthesis)
//
// The extension factory accepts a real pi-coding-agent ExtensionAPI OR our
// ApexExtensionAPI shim, so it loads in both contexts without changes.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryEngine, type MemoryEngine } from "../memory/index.ts";
import { getStore } from "../bootstrap.ts";
import { config } from "../config.ts";
import type { ApexExtensionAPI } from "./host.ts";

const DIM = StringEnum(["working", "episodic", "semantic", "procedural", "declarative"] as const);

export function registerMemoryTools(api: ApexExtensionAPI): void {
  const engine = (): MemoryEngine => getMemoryEngine(getStore()!);

  // ───── apex_search ────────────────────────────────────────────────────
  const apexSearchParams = Type.Object({
    query: Type.String({ description: "Free-form natural-language query." }),
    top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 6 })),
    dimensions: Type.Optional(Type.Array(DIM)),
    expand_graph: Type.Optional(Type.Boolean({ default: true })),
  });
  api.registerTool({
    name: "apex_search",
    label: "Apex Memory Search",
    description:
      "Hybrid search over the 5D memory store. Returns hits with sources (bm25/graph/lexical/recency) and a 0..1 fused score.",
    parameters: apexSearchParams,
    async execute(_id, params: Static<typeof apexSearchParams>, signal) {
      const hits = await engine().search({
        query: String(params.query ?? ""),
        topK: Number(params.top_k ?? 6),
        dimensions: params.dimensions as never,
        expandGraph: params.expand_graph !== false,
      });
      if (signal?.aborted) return { content: [{ type: "text", text: "aborted" }], details: { count: 0 } };
      if (!hits.length) return { content: [{ type: "text", text: "(no memory hits)" }], details: { count: 0 } };
      const text = hits
        .map((h) => {
          const tags = h.record.tags.length ? ` #${h.record.tags.join(" #")}` : "";
          return `[${h.score.toFixed(3)}] (${h.record.dimension}, src=${h.sources.join("+")})${tags}\n  ${h.record.content}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }], details: { count: hits.length, ids: hits.map((h) => h.record.id) } };
    },
  });

  // ───── apex_ingest ────────────────────────────────────────────────────
  api.registerTool({
    name: "apex_ingest",
    label: "Apex Memory Ingest",
    description:
      "Ingest a memory record into the 5D store. Use 'working' for active context, 'episodic' for events, 'semantic' for concepts, 'procedural' for skills, 'declarative' for stable facts.",
    parameters: Type.Object({
      content: Type.String(),
      dimension: DIM,
      tags: Type.Optional(Type.Array(Type.String())),
      importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.5 })),
      meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, params) {
      const rec = await engine().ingest({
        content: String(params.content ?? ""),
        dimension: params.dimension as never,
        tags: (params.tags as string[] | undefined) ?? [],
        importance: params.importance === undefined ? 0.5 : Number(params.importance),
        meta: params.meta as Record<string, unknown> | undefined,
      });
      return { content: [{ type: "text", text: `ingested ${rec.id} (${rec.dimension})` }], details: { id: rec.id } };
    },
  });

  // ───── apex_relate ────────────────────────────────────────────────────
  api.registerTool({
    name: "apex_relate",
    label: "Apex Memory Relate",
    description: "Add a typed edge between two entity labels in the knowledge graph.",
    parameters: Type.Object({
      src: Type.String(),
      rel: Type.String(),
      dst: Type.String(),
      weight: Type.Optional(Type.Number({ default: 1.0 })),
      dimension: Type.Optional(DIM),
    }),
    async execute(_id, params) {
      await engine().relate(
        String(params.src),
        String(params.rel),
        String(params.dst),
        Number(params.weight ?? 1.0),
        params.dimension as never,
      );
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });

  // ───── apex_stats ─────────────────────────────────────────────────────
  api.registerTool({
    name: "apex_stats",
    label: "Apex Memory Stats",
    description:
      "Memory store statistics: total records, per-dimension counts, graph size, last dream time, plus engine mode (local / remote).",
    parameters: Type.Object({}),
    async execute() {
      const s = await engine().stats();
      return { content: [{ type: "text", text: JSON.stringify({ engine: engine().mode(), ...s }, null, 2) }], details: s };
    },
  });

  // ───── apex_feedback ──────────────────────────────────────────────────
  // Natural-language learning: capture user feedback as a memory record
  // with the right importance + tag, so the next dreaming sweep promotes
  // it correctly.
  api.registerTool({
    name: "apex_feedback",
    label: "Apex Feedback (Learn)",
    description:
      "Record natural-language user feedback for the current turn. Use 'up' when the user explicitly approves, 'down' when they correct you, and 'note' for free-form additions. This feeds the learning loop.",
    parameters: Type.Object({
      verdict: StringEnum(["up", "down", "note"] as const),
      comment: Type.Optional(Type.String()),
      dimension: Type.Optional(DIM),
    }),
    async execute(_id, params) {
      const verdict = params.verdict;
      const comment = String(params.comment ?? "").trim();
      const dim = (params.dimension as never) ?? (verdict === "down" ? "procedural" : "semantic");
      const importance = verdict === "down" ? 0.9 : verdict === "up" ? 0.4 : 0.6;
      const tag = verdict === "down" ? "feedback:bad" : verdict === "up" ? "feedback:good" : "feedback:note";
      const text = comment || `(${verdict})`;
      const rec = await engine().ingest({ content: text, dimension: dim, importance, tags: [tag] });
      return { content: [{ type: "text", text: `feedback ingested as ${rec.id} (${dim}, importance=${importance})` }], details: { id: rec.id } };
    },
  });

  // ───── apex_distill ───────────────────────────────────────────────────
  // Self-repair / self-evolve: take a successful tool-call sequence and
  // write it as a SKILL.md so the agent can re-use the pattern.
  api.registerTool({
    name: "apex_distill",
    label: "Apex Distill (Skill Synthesis)",
    description:
      "Distil a successful tool-call sequence from the current session into a SKILL.md candidate and write it to the skills directory. Pass the list of (name, input, output_summary) triples.",
    parameters: Type.Object({
      name: Type.String({ description: "Lower-case skill id, e.g. 'release-checklist'." }),
      steps: Type.Array(
        Type.Object({
          tool: Type.String(),
          input: Type.Optional(Type.Unknown()),
          output: Type.String(),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      const dir = config().skills.dir;
      if (!dir) return { content: [{ type: "text", text: "skills.dir is not configured (set SKILLS_DIR)" }], details: { error: "no_skills_dir", path: undefined } as any, isError: true };
      const name = String(params.name ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
      if (!name) return { content: [{ type: "text", text: "name is required" }], details: { error: "no_name", path: undefined } as any, isError: true };
      const lines: string[] = [
        `# ${name}`,
        ``,
        `> Distilled automatically from a successful agent run.`,
        ``,
        `## When to use`,
        ``,
        `Activate this skill when the user asks for the same multi-step outcome.`,
        ``,
        `## Steps`,
        ``,
      ];
      for (const s of params.steps as Array<{ tool: string; input?: unknown; output?: string }>) {
        const input = s.input ? ` (input: ${JSON.stringify(s.input)})` : "";
        const out = (s.output ?? "").slice(0, 280);
        lines.push(`1. **${s.tool}**${input}`);
        if (out) lines.push(`   - Expected output: \`${out.replace(/\n/g, " ")}\``);
      }
      const skillDir = join(dir, name);
      mkdirSync(skillDir, { recursive: true });
      const path = join(skillDir, "SKILL.md");
      writeFileSync(path, lines.join("\n") + "\n", "utf8");
      // Notify the runtime so a re-load picks up the new skill.
      api.emit("skill_loaded", { name, path });
      return { content: [{ type: "text", text: `distilled skill written to ${path}` }], details: { error: undefined, path } as any };
    },
  });

  // ───── apex_list_skills ───────────────────────────────────────────────
  api.registerTool({
    name: "apex_list_skills",
    label: "Apex List Skills",
    description: "List all skills visible to the agent (built-in + SKILLS_DIR).",
    parameters: Type.Object({}),
    async execute() {
      const { SKILLS } = await import("../skills/index.ts");
      const names = Object.keys(SKILLS);
      return {
        content: [{ type: "text", text: names.length ? names.map((n) => `• ${n}`).join("\n") : "(no skills loaded)" }],
        details: { names },
      };
    },
  });

  // (end of registerMemoryTools)
}
