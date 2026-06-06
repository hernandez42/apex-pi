// src/agent.ts
//
// The apex-pi Agent singleton. Wraps @earendil-works/pi-agent-core's
// `Agent` class with our system prompt (INSTINCTS + base + genes), default model
// (from env), and a freshly-bootstrapped extension host.
//
// P0 Enhancement: Gene维 + ApexSpiral 注入
//   - systemPrompt now includes: INSTINCTS + GENE_CONTEXT + APEX_SELF + BASE_PROMPT
//   - Gene context from gene_network.ts (selectBestGenes)
//   - Self description from apex_spiral.ts (getSelfDescription)
//   - Both refreshed every 60 seconds (cache)

import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type Model } from "@earendil-works/pi-ai";
import { config } from "./config.ts";
import { boot, shutdown as bootstrapShutdown, getStore } from "./bootstrap.ts";
import { installApexExtensions, INSTINCTS, BASE_PROMPT, createExtensionHost } from "./extensions/index.ts";
import { getMemoryEngine } from "./memory/index.ts";
import { log } from "./log.ts";
import { resolveModel } from "./llm.ts";
import { selectBestGenes, expressGene, getGeneNetworkStats } from "./evo/gene_network.ts";
import { getSelfDescription, apexSpiralTick, recordDeltaG } from "./evo/apex_spiral.ts";

// ─── Gene Context Cache ──────────────────────────────────────────────────────

let _cachedGeneContext = "";
let _cachedGeneStats = "";
let _lastGeneRefresh = 0;
const GENE_REFRESH_MS = 60 * 1000;

async function _refreshGeneContext(query = ""): Promise<string> {
  const now = Date.now();
  if (now - _lastGeneRefresh < GENE_REFRESH_MS && _cachedGeneContext) {
    return _cachedGeneContext;
  }
  try {
    const genes = selectBestGenes(query, 5);
    if (genes.length === 0) {
      _cachedGeneContext = "";
      _cachedGeneStats = "";
    } else {
      genes.forEach(g => expressGene(g.gene_id));
      const geneLines = genes.map((g, i) =>
        `[Gene ${i + 1}] delta_g=${g.delta_g} fitness=${g.fitness.toFixed(2)}\n` +
        g.content.slice(0, 300)
      ).join("\n\n");
      const stats = getGeneNetworkStats();
      _cachedGeneContext = `[GENE MEMORY -- ${genes.length} active genes injected]\n${geneLines}`;
      _cachedGeneStats = `[Gene Network] total=${stats.total} | active=${stats.by_state.active} | topDeltaG=${stats.top_delta_g} | avgFitness=${stats.avg_fitness.toFixed(2)}`;
    }
    _lastGeneRefresh = now;
  } catch (e) {
    log.warn("agent.gene_context_refresh_failed", { err: String(e) });
    _cachedGeneContext = "";
  }
  return _cachedGeneContext;
}

// ─── Singleton State ─────────────────────────────────────────────────────────

let agent: Agent | undefined;
let host: ReturnType<typeof createExtensionHost> | undefined;
let bootstrapped = false;

function ensureBoot(): void {
  if (!bootstrapped) {
    boot();
    bootstrapped = true;
  }
}

function getHost(): ReturnType<typeof createExtensionHost> {
  if (host) return host;
  ensureBoot();
  host = createExtensionHost({ cwd: process.cwd() });
  installApexExtensions(host);
  return host;
}

export { resolveModel };

export interface AgentOptions {
  model?: Model<any>;
  skills?: string[];
  system?: string;
  geneQuery?: string;
}

// ─── Agent Singleton ────────────────────────────────────────────────────────

export function getAgent(opts: AgentOptions = {}): Agent {
  if (agent) return agent;

  const cfg = config();
  const h = getHost();
  const model = opts.model ?? resolveModel();

  const systemPrompt = [
    INSTINCTS.join("\n\n"),
    opts.system ?? BASE_PROMPT,
    (opts.skills ?? []).join("\n\n"),
  ].filter(Boolean).join("\n\n");

  agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: cfg.llm.thinkingLevel,
      tools: h.tools() as AgentTool<any, any>[],
    },
  });

  agent.subscribe(async (ev: AgentEvent) => {
    if (ev.type === "tool_execution_end" && (ev as { isError?: boolean }).isError) {
      const store = getStore();
      if (!store) return;
      try {
        await getMemoryEngine(store).ingest({
          content: `tool ${(ev as { toolName: string }).toolName} failed at ${new Date().toISOString()}`,
          dimension: "procedural",
          tags: ["tool-error"],
          importance: 0.3,
        });
      } catch (err) {
        log.warn("agent.error.log.fail", { err: (err as Error).message });
      }
    }

    if (ev.type === "turn_end") {
      const turnEv = ev as { toolResults?: Array<{ toolName: string }> };
      const toolCount = turnEv.toolResults?.length ?? 0;
      recordDeltaG(toolCount * 5);
      apexSpiralTick(toolCount * 5).catch(e => {
        log.debug("agent.apex_spiral_tick_err", { err: String(e) });
      });
    }
  });

  _refreshGeneContext(opts.geneQuery ?? "").catch(e => {
    log.warn("agent.gene_cache_warm_failed", { err: String(e) });
  });

  log.info("agent.init", {
    model: `${cfg.llm.provider}/${cfg.llm.model}`,
    tools: h.tools().length,
    geneInjection: true,
  });

  return agent;
}

export function resetAgentForTests(): void {
  agent = undefined;
  host = undefined;
  bootstrapped = false;
}

export function shutdown(): void {
  bootstrapShutdown();
  agent = undefined;
  host = undefined;
  bootstrapped = false;
}

export async function* streamAgent(prompt: string, opts: AgentOptions = {}): AsyncIterable<AgentEvent> {
  const a = getAgent(opts);
  const queue: AgentEvent[] = [];
  let resolveNext: ((v: IteratorResult<AgentEvent>) => void) | null = null;
  let done = false;
  const unsub = a.subscribe((ev: AgentEvent) => {
    if (done) return;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
  });
  try {
    a.prompt(prompt).catch((e: Error) => log.error("agent.prompt.err", { err: (e as Error).message }));
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (done) return;
      const ev = await new Promise<IteratorResult<AgentEvent>>((r) => (resolveNext = r));
      if (ev.done) return;
      yield ev.value;
    }
  } finally {
    done = true;
    unsub();
  }
}