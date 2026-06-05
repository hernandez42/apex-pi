// src/agent.ts
//
// The apex-pi Agent singleton. Wraps @earendil-works/pi-agent-core's
// `Agent` class with our system prompt (INSTINCTS + base), default model
// (from env), and a freshly-bootstrapped extension host.
//
// Use:
//   import { getAgent } from "./agent.ts";
//   const agent = getAgent();
//   await agent.prompt("explain this project");
//
// The Agent emits a rich event stream — see `streamAgent()` for an async
// iterator wrapper.

import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, type Model } from "@earendil-works/pi-ai";
import { config } from "./config.ts";
import { boot, shutdown as bootstrapShutdown, getStore } from "./bootstrap.ts";
import { installApexExtensions, INSTINCTS, BASE_PROMPT, createExtensionHost } from "./extensions/index.ts";
import { getMemoryEngine } from "./memory/index.ts";
import { log } from "./log.ts";

let agent: Agent<any> | undefined;
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

/** Resolve the model via pi-ai's getModel(provider, id). Falls back to
 *  the OpenAI "gpt-4o-mini" preset if the env provider is unknown. */
export function resolveModel(): Model<any> {
  const cfg = config().llm;
  try {
    return getModel(cfg.provider, cfg.model);
  } catch (e) {
    log.warn("model.resolve.fail", { provider: cfg.provider, model: cfg.model, err: (e as Error).message });
    return getModel("openai", "gpt-4o-mini");
  }
}

export interface AgentOptions {
  model?: Model<any>;
  skills?: string[];
  system?: string;
}

/** Build (or return cached) Agent instance. */
export function getAgent(opts: AgentOptions = {}): Agent<any> {
  if (agent) return agent;
  const cfg = config();
  const h = getHost();
  const model = opts.model ?? resolveModel();
  const systemPrompt = [INSTINCTS.join("\n\n"), opts.system ?? BASE_PROMPT, (opts.skills ?? []).join("\n\n")]
    .filter(Boolean)
    .join("\n\n");
  agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: cfg.llm.thinkingLevel,
      tools: h.tools() as AgentTool<any, any>[],
    },
  });

  // Self-repair: when a tool returns isError, log the failure into memory
  // as a `procedural` anti-pattern. The dreamer sweep will eventually
  // promote repeated patterns into `semantic` knowledge.
  agent.subscribe(async (ev) => {
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
  });

  log.info("agent.init", { model: `${cfg.llm.provider}/${cfg.llm.model}`, tools: h.tools().length });
  return agent;
}

/** Reset the agent + extensions (test helper). */
export function resetAgentForTests(): void {
  agent = undefined;
  host = undefined;
  bootstrapped = false;
}

/** Tear down everything for graceful shutdown. */
export function shutdown(): void {
  bootstrapShutdown();
  agent = undefined;
  host = undefined;
  bootstrapped = false;
}

/** Async-iterator wrapper around the Agent's event stream. */
export async function* streamAgent(prompt: string, opts: AgentOptions = {}): AsyncIterable<AgentEvent> {
  const a = getAgent(opts);
  const queue: AgentEvent[] = [];
  let resolveNext: ((v: IteratorResult<AgentEvent>) => void) | null = null;
  let done = false;
  const unsub = a.subscribe((ev) => {
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
    // Kick off the prompt in the background.
    a.prompt(prompt).catch((e) => log.error("agent.prompt.err", { err: (e as Error).message }));
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
