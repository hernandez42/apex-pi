// src/bootstrap.ts
// One-time process bootstrap. Opens the memory store, starts the dreamer,
// loads skills. Idempotent.

import { config } from "./config.ts";
import { log } from "./log.ts";
import {
  Dreamer,
  getMemoryEngine,
  openMemoryStore,
  type MemoryEngine,
  type MemoryStore,
} from "./memory/index.ts";
import { loadSkillsFromDir } from "./skills/index.ts";

export interface AppContext {
  store: MemoryStore;
  engine: MemoryEngine;
}

let booted = false;
let ctx: AppContext | undefined;
let dreamer: Dreamer | undefined;

export function boot(): AppContext {
  if (booted && ctx) return ctx;
  const cfg = config();
  const store = openMemoryStore({
    dataDir: cfg.dataDir,
    cap: cfg.memory.cap,
    dedupThreshold: cfg.memory.dedupThreshold,
  });
  const engine = getMemoryEngine(store);
  loadSkillsFromDir(cfg.skills.dir);
  dreamer = new Dreamer(engine);
  dreamer.start();
  ctx = { store, engine };
  booted = true;
  log.info("boot.ok", { dataDir: cfg.dataDir, engine: engine.mode() });
  return ctx;
}

export function shutdown(): void {
  if (dreamer) dreamer.stop();
  if (ctx) ctx.store.close();
  booted = false;
  ctx = undefined;
  dreamer = undefined;
}

/** Full teardown including the (async) workflow engine. Use this from
 *  long-lived entry points (HTTP server, CLI main). Tests can stick to
 *  the sync {@link shutdown} since they never start the workflow engine. */
export async function fullShutdown(): Promise<void> {
  shutdown();
  const { stopWorkflows } = await import("./workflows.ts");
  await stopWorkflows().catch((e) => log.warn("workflows.shutdown.fail", { err: (e as Error).message }));
}

export function getStore(): MemoryStore | undefined {
  return ctx?.store;
}
