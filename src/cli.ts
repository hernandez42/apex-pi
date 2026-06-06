// src/cli.ts
// CLI entry: dispatches to one of {http server, MCP server, Feishu bot,
// one-shot agent turn, stats}. The HTTP server is the default.
//
// The CLI is intentionally thin — it imports the relevant module, which
// in turn wires the Agent singleton.

import { config } from "./config.ts";
import { log } from "./log.ts";
import { boot, fullShutdown } from "./bootstrap.ts";
import { getMemoryEngine } from "./memory/index.ts";
import { getAgent } from "./agent.ts";
import { getCodegraph } from "./codegraph/index.ts";
import { isAbsolute, resolve } from "node:path";

function usage(): void {
  console.log(`apex-pi — a pi-mono distribution with apex-mem, codegraph, understand, Feishu.

Usage:
  apex-pi                                start the HTTP server (default)
  apex-pi "explain this project"         one-shot agent turn
  apex-pi --repl                         not supported in this distribution
                                          (use \`pi --extension apex-pi\` for TUI)
  apex-pi --feishu                       start the Feishu WebSocket bot
  apex-pi --mcp                          start a standalone MCP server (stdio)
  apex-pi --understand [path]            run the /understand pipeline
  apex-pi --ingest <dim> <text...>       ingest a memory record
  apex-pi --search <query>               search the 5D memory store
  apex-pi --stats                        show memory + codegraph stats

Environment:
  LLM_PROVIDER, LLM_MODEL, LLM_THINKING
  APEX_PI_DATA=/data                     persistent volume
  APEXMEM_URL=http://host/mcp/rpc        delegate memory to the Rust apex-mem
  FEISHU_ENABLED=1, FEISHU_APP_ID, FEISHU_APP_SECRET
  MCP_ENABLED=1, MCP_MOUNT_PATH=/mcp     expose MCP over HTTP
`);
}

async function startHttp(): Promise<void> {
  boot();
  const { startWorkflows } = await import("./workflows.ts");
  await startWorkflows();
  const { createApp } = await import("./http/server.ts");
  const cfg = config().http;
  const app = createApp();
  const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: app.fetch });
  log.info("http.listening", { port: server.port, url: `http://${cfg.host}:${server.port}` });
  const stop = async (sig: string) => {
    log.info("http.shutdown", { sig });
    server.stop();
    await fullShutdown();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  // Keep the process alive.
  await new Promise<never>(() => {});
}

async function startFeishuWS(): Promise<void> {
  boot();
  const { getAgent } = await import("./agent.ts");
  const { wireEvo } = await import("./evo/wiring.ts");
  await wireEvo(getAgent);
  const { createFeishuMom } = await import("./channels/feishu.ts");
  const mom = createFeishuMom({
    useCard: config().feishu.useCard,
    maxReplyChars: config().feishu.maxReplyChars,
  });
  await mom.startWS();
  // Also start the HTTP server so the /v1/feishu/webhook is exposed.
  await startHttp();
}

async function startMcp(): Promise<void> {
  // Read JSON-RPC from stdin, write to stdout (MCP stdio transport).
  const { handleMcp } = await import("./mcp/server.ts");
  const dec = new TextDecoder();
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const req = new Request("http://mcp.local/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: line,
        });
        const res = await handleMcp(req);
        const text = await res.text();
        process.stdout.write(text + "\n");
      } catch (e) {
        process.stderr.write(`[mcp] ${(e as Error).message}\n`);
      }
    }
  }
}

async function oneShot(prompt: string): Promise<number> {
  boot();
  const agent = getAgent();
  let full = "";
  const sub = agent.subscribe((ev: import("@earendil-works/pi-agent-core").AgentEvent) => {
    if (ev.type === "message_update") {
      const mue = (ev as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (mue?.type === "text_delta" && mue.delta) {
        process.stdout.write(mue.delta);
        full += mue.delta;
      }
    }
  });
  try {
    await agent.prompt(prompt);
    process.stdout.write("\n");
    log.info("cli.oneshot.done");
    return 0;
  } finally {
    sub();
  }
}

async function runUnderstand(p: string): Promise<number> {
  boot();
  const { understand } = await import("./understand/index.ts");
  const root = isAbsolute(p) ? p : resolve(process.cwd(), p);
  const r = await understand({ root });
  console.log(`# Summary\n${r.summary}\n`);
  console.log(`# Hotspots`);
  for (const h of r.hotspots) console.log(`- ${h.file} (${h.symbols} sym, ${h.exports} exp)`);
  console.log(`# Languages`);
  for (const [k, v] of Object.entries(r.languages)) console.log(`- ${k}: ${v} files`);
  return 0;
}

async function ingestCli(dim: string, text: string): Promise<number> {
  const store = boot().store;
  const rec = await getMemoryEngine(store).ingest({ dimension: dim as never, content: text });
  console.log(JSON.stringify(rec, null, 2));
  return 0;
}

async function searchCli(q: string): Promise<number> {
  boot();
  const hits = await getMemoryEngine((await import("./bootstrap.ts")).getStore()!).search({ query: q, topK: 10 });
  for (const h of hits) console.log(`[${h.score.toFixed(3)}] (${h.record.dimension}) ${h.record.content}`);
  return 0;
}

async function statsCli(): Promise<number> {
  boot();
  const engine = getMemoryEngine((await import("./bootstrap.ts")).getStore()!);
  console.log(JSON.stringify({ engine: engine.mode(), memory: await engine.stats(), codegraph: getCodegraph().stats() }, null, 2));
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--serve") {
    await startHttp();
    return 0;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    usage();
    return 0;
  }
  if (args[0] === "--feishu" || args[0] === "feishu") {
    process.env.FEISHU_ENABLED = "1";
    await startFeishuWS();
    return 0;
  }
  if (args[0] === "--mcp" || args[0] === "mcp") {
    process.env.MCP_ENABLED = "1";
    await startMcp();
    return 0;
  }
  if (args[0] === "--understand") return runUnderstand(args[1] ?? ".");
  if (args[0] === "--ingest") return ingestCli(args[1] ?? "semantic", args.slice(2).join(" "));
  if (args[0] === "--search") return searchCli(args.slice(1).join(" "));
  if (args[0] === "--stats") return statsCli();
  return oneShot(args.join(" "));
}

const code = await main().catch((e) => {
  log.error("cli.fatal", { err: (e as Error).message, stack: (e as Error).stack });
  return 1;
});
await fullShutdown();
process.exit(code);
