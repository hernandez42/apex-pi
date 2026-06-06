/**
console.error("XUANJI wiring.ts MODULE LOADED");
 * pi-evo Wiring Layer — 激活全部沉睡的自进化回路.
 *
 * 五个集成点全部打通:
 *   1. Dreamer → curatorTick()  skill生命周期管理
 *   2. Agent turn_end → onTurnComplete()  turn-after fork review
 *   3. 定时扫描 → runEvolutionPipeline()  自动bug修复
 *   4. Dreamer → sparkRippleTick()  moss SPW-R 基因选择 (每3分钟)
 *   5. Dreamer → apexSpiralTick()  ApexSpiral 5公理自我指涉
 *   6. Dreamer → evolveNetwork()  基因网络进化 ← NEW
 *
 * 只需在 bootstrap.ts 之后调用一次: wireEvo().
 */

import { boot, getDreamer } from "../bootstrap.ts";
import { onTurnComplete } from "./background-review.ts";
import { curatorTick } from "./curator.ts";
import { scanForFailures, runEvolutionPipeline, loadStore } from "./pipeline.ts";
import { sparkRippleTick } from "./moss.ts";
import { apexSpiralTick } from "./apex_spiral.ts";
import { evolveNetwork } from "./gene_network.ts";
import { log } from "../log.ts";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface EvoWiringConfig {
  curatorIntervalTicks: number;
  autoApproveDeltaG: number;
  sessionDir: string;
  evolutionScanIntervalMs: number;
  backgroundReviewEnabled: boolean;
  backgroundReviewTurnInterval: number;
  apexSpiralIntervalTicks: number;
  geneNetworkIntervalTicks: number;
}

const DEFAULT_CONFIG: EvoWiringConfig = {
  curatorIntervalTicks: 1,
  autoApproveDeltaG: 100,
  sessionDir: "sessions",
  evolutionScanIntervalMs: 5 * 60 * 1000,
  backgroundReviewEnabled: true,
  backgroundReviewTurnInterval: 3,
  apexSpiralIntervalTicks: 1,
  geneNetworkIntervalTicks: 10,
};

let _config: EvoWiringConfig = { ...DEFAULT_CONFIG };
let _dreamerTick = 0;
let _userTurnCount = 0;
let _lastEvolutionScan = 0;
let _scanTimer: ReturnType<typeof setInterval> | undefined;
let _wired = false;

export function updateEvoWiringConfig(cfg: Partial<EvoWiringConfig>): void {
  _config = { ..._config, ...cfg };
  log.info("evo.wiring.config_updated", _config);
}

// ─── Shared tick wrapper ────────────────────────────────────────────────────
//
// Wraps a Dreamer tick: runs orig, then fires all 5 sub-loops.
// Called once per Dreamer interval (default: 30 min).
async function dreamerTickWrapper(this: object): Promise<void> {
  const { Dreamer } = await import("../memory/dreamer.ts");
  const origRun = Dreamer.prototype.run as (this: object) => Promise<void>;
  _dreamerTick++;
  const tick = _dreamerTick;
  await origRun.call(this);

  if (_config.curatorIntervalTicks > 0 && tick % _config.curatorIntervalTicks === 0) {
    try {
      await curatorTick();
      log.info("evo.wiring.curator_tick", { tick, dreamerTick: tick });
    } catch (e) { log.error("evo.wiring.curator_tick_err", { err: String(e) }); }
  }

  try { await sparkRippleTick(); }
  catch (e) { log.error("evo.wiring.moss_ripple_err", { err: String(e) }); }

  if (_config.apexSpiralIntervalTicks > 0 && tick % _config.apexSpiralIntervalTicks === 0) {
    try { await apexSpiralTick(); }
    catch (e) { log.error("evo.wiring.apex_spiral_err", { err: String(e) }); }
  }

  if (_config.geneNetworkIntervalTicks > 0 && tick % _config.geneNetworkIntervalTicks === 0) {
    try {
      const stats = await evolveNetwork();
      if (stats.new_genes > 0) log.info("evo.wiring.gene_network_evolved", stats);
    } catch (e) { log.error("evo.wiring.gene_network_err", { err: String(e) }); }
  }
}

// ─── 1. Wire Agent turn_end → onTurnComplete ───────────────────────────────

export function wireAgentToEvo(getAgentFn: () => import("@earendil-works/pi-agent-core").Agent): void {
  const agent = getAgentFn();

  agent.subscribe(async (ev: AgentEvent) => {
    if (ev.type !== "turn_end") return;

    const turnEv = ev as {
      turnIndex: number;
      message: { content?: string };
      toolResults?: Array<{ toolName: string; isError?: boolean }>;
    };

    _userTurnCount++;

    const snapshot = {
      messages: [
        { role: "system" as const, content: "[INSTINCTS + BASE_PROMPT]" },
        { role: "user" as const, content: turnEv.message.content ?? "" },
      ],
      loadedSkills: [] as string[],
      toolCalls: (turnEv.toolResults ?? []).map((r) => ({
        name: r.toolName,
        arguments: JSON.stringify(r),
      })),
    };

    const shouldFork = (
      _config.backgroundReviewEnabled &&
      _userTurnCount % _config.backgroundReviewTurnInterval === 0
    );

    if (shouldFork) {
      onTurnComplete({
        userMessage: turnEv.message.content ?? "",
        assistantMessage: turnEv.message.content ?? "",
        finalText: turnEv.message.content,
        toolIterations: turnEv.toolResults?.length ?? 0,
        interrupted: false,
        snapshot,
      }).catch((e) => { log.error("evo.wiring.turn_complete_err", { err: String(e) }); });
    }
  });

  log.info("evo.wiring.agent_wired", { turnInterval: _config.backgroundReviewTurnInterval });
}

// ─── 2. Wire Dreamer → all sub-loops ───────────────────────────────────────

export async function wireDreamerToCurator(): Promise<void> {
  const { Dreamer } = await import("../memory/dreamer.ts");
  const origRun = Dreamer.prototype.run as (this: object) => Promise<void>;

  // Patch prototype (new Dreamer instances use this)
  (Dreamer.prototype.run as (this: object) => Promise<void>) = dreamerTickWrapper;

  // CRITICAL: also patch the ALREADY-RUNNING instance.
  // boot() is called before wireEvo(), so the Dreamer is already instantiated.
  const running = getDreamer();
  console.error("XUANJI IN DREAMER WRAPPER");
  if (running) {
    (running as unknown as { run: typeof origRun }).run = dreamerTickWrapper as typeof origRun;
    log.info("evo.wiring.dreamer_instance_patched", { dreamerTick: _dreamerTick });
  }

  log.info("evo.wiring.dreamer_wired", {
    curatorIntervalTicks: _config.curatorIntervalTicks,
    apexSpiralIntervalTicks: _config.apexSpiralIntervalTicks,
    geneNetworkIntervalTicks: _config.geneNetworkIntervalTicks,
  });
}

// ─── 3. Wire 定时扫描 → runEvolutionPipeline ─────────────────────────────────

export function startEvolutionScan(): void {
  if (_scanTimer) return;

  const home = boot().config?.home ?? (globalThis as Record<string, unknown>).APEX_PI_HOME ?? "~/.apex-pi";
  const homedir = home.replace("~", process.env.HOME ?? "/root");
  const sessionDir = homedir + "/" + _config.sessionDir;

  _scanTimer = setInterval(async () => {
    try {
      const now = Date.now();
      if (now - _lastEvolutionScan < _config.evolutionScanIntervalMs) return;
      _lastEvolutionScan = now;

      const chunks = await scanForFailures(sessionDir);
      if (chunks.length === 0) return;

      log.info("evo.wiring.scan_done", { failures: chunks.length });

      const existing = await loadStore();
      const recentIds = new Set(existing.map((b) => b.id));

      for (const chunk of chunks) {
        const ts = chunk.timestamp.replace(/[:.]/g, "");
        const batchId = `evo_${chunk.session_id}_${ts}`;
        if (recentIds.has(batchId)) continue;

        const batch = {
          id: batchId,
          failure_chunks: [chunk],
          root_cause: chunk.error_type,
          candidate_patch: null as string | null,
          status: "pending" as const,
          delta_g: 0,
          created_at: new Date().toISOString(),
          verdict: "pending" as const,
        };

        runEvolutionPipeline(batch).catch((e) => {
          log.error("evo.wiring.pipeline_err", { batch_id: batch.id, err: String(e) });
        });
      }
    } catch (e) {
      log.error("evo.wiring.scan_err", { err: String(e) });
    }
  }, _config.evolutionScanIntervalMs);

  log.info("evo.wiring.scan_started", { intervalMs: _config.evolutionScanIntervalMs, sessionDir });
}

export function stopEvolutionScan(): void {
  if (_scanTimer) {
    clearInterval(_scanTimer);
    _scanTimer = undefined;
    log.info("evo.wiring.scan_stopped");
  }
}

// ─── Master Wire ─────────────────────────────────────────────────────────────

export async function wireEvo(getAgentFn: () => import("@earendil-works/pi-agent-core").Agent): Promise<void> {
  if (_wired) return;
  _wired = true;

  log.info("evo.wiring.start");

  await wireDreamerToCurator();
  wireAgentToEvo(getAgentFn);
  startEvolutionScan();

  log.info("evo.wiring.complete", {
    curatorTicks: _config.curatorIntervalTicks,
    forkTurns: _config.backgroundReviewTurnInterval,
    scanIntervalMs: _config.evolutionScanIntervalMs,
    apexSpiralIntervalTicks: _config.apexSpiralIntervalTicks,
    geneNetworkIntervalTicks: _config.geneNetworkIntervalTicks,
  });
}

export function isWired(): boolean {
  return _wired;
}