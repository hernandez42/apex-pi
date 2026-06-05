// src/mcp-cli.ts
// Entry point for the `apex-mcp` binary: serves the MCP Streamable HTTP endpoint
// on $MCP_PORT (default 8081). Use `apex-pi mcp-stdio` from the main CLI for
// line-based stdio mode.

import { Hono } from "hono";
import { boot, shutdown } from "./bootstrap.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { handleMcp } from "./mcp/server.ts";

async function main() {
  const port = Number(process.env.MCP_PORT ?? 8081);
  await boot();
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, mode: "mcp" }));
  app.all("/mcp", (c) => handleMcp(c.req.raw));
  app.all("/mcp/*", (c) => handleMcp(c.req.raw));
  const server = Bun.serve({ port, hostname: "0.0.0.0", fetch: app.fetch });
  log.info({ port, provider: config().llm.provider, model: config().llm.model }, "apex-mcp listening");

  const stop = async (sig: NodeJS.Signals) => {
    log.info({ sig }, "apex-mcp shutting down");
    try { server.stop(); } catch (e) { log.warn({ err: String(e) }, "server.stop threw"); }
    try { await shutdown(); } catch (e) { log.warn({ err: String(e) }, "shutdown threw"); }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<never>(() => {});
}

main().catch((e) => {
  log.error({ err: String(e), stack: (e as Error)?.stack }, "apex-mcp crashed");
  process.exit(1);
});
