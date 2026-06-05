// src/setup-check.ts — one-shot environment diagnostic.
// Run with:  bun run src/setup-check.ts

import { config } from "./config.ts";
import { log } from "./log.ts";

const ok = (label: string, extra?: unknown): void => {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${label}${extra ? `  ${JSON.stringify(extra)}` : ""}\n`);
};
const warn = (label: string, extra?: unknown): void => {
  process.stdout.write(`\x1b[33m!\x1b[0m ${label}${extra ? `  ${JSON.stringify(extra)}` : ""}\n`);
};
const err = (label: string, extra?: unknown): void => {
  process.stdout.write(`\x1b[31m✗\x1b[0m ${label}${extra ? `  ${JSON.stringify(extra)}` : ""}\n`);
};
const section = (title: string): void => {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
};

const cfg = config();

section("runtime");
ok("bun", { version: Bun.version, sha: Bun.revision.slice(0, 8) });
ok("platform", { os: process.platform, arch: process.arch });

section("LLM");
ok("provider/model", { provider: cfg.llm.provider, model: cfg.llm.model });
if (!process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  warn("no API key in env (LLM_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)");
} else {
  ok("API key present");
}
if (cfg.llm.provider === "openai-compatible" || process.env.LLM_BASE_URL) {
  try {
    const t0 = Date.now();
    const base = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const res = await fetch(`${base}/models`);
    const dt = Date.now() - t0;
    if (res.ok) ok("reachable", { ms: dt, status: res.status });
    else warn("not reachable", { ms: dt, status: res.status });
  } catch (e) {
    warn("probe failed", { err: (e as Error).message });
  }
}

section("storage");
ok("data dir", { path: cfg.dataDir });

section("Feishu");
if (cfg.feishu.enabled) {
  if (cfg.feishu.appId && cfg.feishu.appSecret) ok("credentials set");
  else err("FEISHU_ENABLED=1 but credentials are missing");
} else {
  warn("disabled");
}

section("MCP");
ok("enabled", { enabled: cfg.mcp.enabled, mount: cfg.mcp.mountPath });

section("memory budget (idle RSS estimate)");
const budget: Record<string, number> = {
  "bun runtime": 30,
  "pi-ai + pi-agent-core": 12,
  "apex-mem engine": 4,
  "codegraph": 5,
  "hono + json": 2,
  "feishu sdk (when enabled)": cfg.feishu.enabled ? 20 : 0,
  "agent headroom": 60,
};
let total = 0;
for (const [k, v] of Object.entries(budget)) {
  process.stdout.write(`  ${k.padEnd(34)} ${v} MB\n`);
  total += v as number;
}
process.stdout.write(`  ${"TOTAL".padEnd(34)} ${total} MB\n`);
if (total > 256) err(`estimated RSS ${total} MB exceeds Fly.io free tier (256 MB)`);
else ok(`fits in 256 MB free tier with ${256 - total} MB headroom`);

log.info("setup-check.ok", { totalMb: total });
