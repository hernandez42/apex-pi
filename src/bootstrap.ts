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

export function getStore(): MemoryStore | undefined {
  return ctx?.store;
}
