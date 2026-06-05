// src/memory/dreamer.ts
// Background scheduler that calls engine.dream() every N minutes.

import { log } from "../log.ts";
import type { MemoryEngine } from "./bridge.ts";
import { config } from "../config.ts";

export class Dreamer {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private engine: MemoryEngine) {}

  start(): void {
    if (this.timer) return;
    const min = config().memory.dreamIntervalMin;
    const ms = Math.max(1, min) * 60 * 1000;
    this.timer = setInterval(() => this.run().catch((e) => log.error("dreamer.err", { err: (e as Error).message })), ms);
    // also run once at start, deferred so it doesn't block boot
    setTimeout(() => this.run().catch((e) => log.error("dreamer.err", { err: (e as Error).message })), 10_000);
    log.info("dreamer.started", { intervalMin: min });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async run(): Promise<void> {
    if (this.engine.mode() === "remote") {
      // Don't run dreaming on the remote engine — the Rust side handles it.
      return;
    }
    const r = await this.engine.dream();
    log.info("dreamer.tick", r);
  }
}
