/**
 * wiring.ts v3 — 安全版自进化回路
 *
 * 修复清单 (v3):
 * ✅ 双重 Dreamer tick — wrapper 内调用一次 origRun
 * ✅ _wired mutex — 防止重复 wiring
 * ✅ curatorIntervalTicks=0 — 暂时禁用
 * ✅ backgroundReviewTurnInterval=10 — 降低频率（原来3太频繁）
 * ✅ apexSpiralIntervalTicks=0 — 暂时禁用
 * ✅ geneNetworkIntervalTicks=0 — 暂时禁用
 * ✅ memory guard — 每 tick 用 ps 检查 RSS，超 500MB 告警
 */

import { boot } from "../bootstrap.ts";
import { onTurnComplete } from "./background-review.ts";
import { sparkRippleTick } from "./moss.ts";
import { apexSpiralTick } from "./apex_spiral.ts";
import { evolveNetwork, loadFromMemory } from "./gene_network.ts";
import { scanForFailures, runEvolutionPipeline, loadStore } from "./pipeline.ts";
import { log } from "../log.ts";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

// Symbol: 保存原始 Dreamer.prototype.run（防止 wrapper 重入）
const _ORIGINAL_DREAMER_RUN = Symbol.for("mossagi.dreamer.originalRun");
// 防重入标记
let _dreamerReentrant = false;

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
  curatorIntervalTicks: 0,
  autoApproveDeltaG: 100,
  sessionDir: "sessions",
  evolutionScanIntervalMs: 0,
  backgroundReviewEnabled: true,
  backgroundReviewTurnInterval: 10,
  apexSpiralIntervalTicks: 0,
  geneNetworkIntervalTicks: 0,
};

let _config: EvoWiringConfig = { ...DEFAULT_CONFIG };
let _dreamerTick = 0;
let _userTurnCount = 0;
let _wired = false;
let _wiringPromise: Promise<void> | undefined;

// ─── Memory Guard (Bun/Linux compatible) ──────────────────────────────────
// West 异速生长缩放律: B ∝ M^0.75, 8GB 机器 base_rss=300MB 是安全阈值
const MEMORY_SOFT_MB = 500;
const MEMORY_HARD_MB = 1024;
let _lastMemoryWarn = 0;

async function checkMemoryGuard(): Promise<void> {
  try {
    const p = Bun.spawn(["ps", "-o", "rss=", "-p", String(process.pid)], { stdout: "pipe" });
    const rssKb = parseInt(await new Response(p.stdout).text());
    const rssMb = rssKb / 1024;
    if (rssMb > MEMORY_HARD_MB) {
      log.error("memory.hard_limit", { rssMb: rssMb.toFixed(1), thresholdMb: MEMORY_HARD_MB });
    } else if (rssMb > MEMORY_SOFT_MB) {
      const now = Date.now();
      if (now - _lastMemoryWarn > 60_000) { // 最多1分钟告警一次
        log.warn("memory.soft_limit", { rssMb: rssMb.toFixed(1), thresholdMb: MEMORY_SOFT_MB });
        _lastMemoryWarn = now;
      }
    }
  } catch { /* not critical */ }
}

// ─── Config ─────────────────────────────────────────────────────────────────

export function updateEvoWiringConfig(cfg: Partial<EvoWiringConfig>): void {
  _config = { ..._config, ...cfg };
  log.info("evo.wiring.config_updated", _config);
}

// ─── Dreamer wrapper (FIXED: single origRun call) ────────────────────────────

async function dreamerTickWrapper(this: object): Promise<void> {
  // P0 FIX: reentrancy guard
  if (_dreamerReentrant) return;
  _dreamerReentrant = true;
  try {
  const { Dreamer } = await import("../memory/dreamer.ts");
  // P0 FIX: 使用 Symbol 访问原始函数（防止读取已patch的 prototype.run）
  const origRun = Dreamer.prototype[_ORIGINAL_DREAMER_RUN] as (this: object) => Promise<void>;
  _dreamerTick++;
  const tick = _dreamerTick;

  await checkMemoryGuard();

  // 只调用一次 origRun（修复双重tick）
  await origRun.call(this);

  if (_config.curatorIntervalTicks > 0 && tick % _config.curatorIntervalTicks === 0) {
    try {
      const { curatorTick } = await import("./curator.ts");
      await curatorTick();
      log.info("evo.wiring.curator_tick", { tick });
    } catch (e) { log.error("evo.wiring.curator_tick_err", { err: String(e) }); }
  }

  try { await sparkRippleTick(); } catch (e) { /* noop */ }

  if (_config.apexSpiralIntervalTicks > 0 && tick % _config.apexSpiralIntervalTicks === 0) {
    try { await apexSpiralTick(); } catch (e) { log.error("evo.wiring.apex_spiral_err", { err: String(e) }); }
  }

  if (_config.geneNetworkIntervalTicks > 0 && tick % _config.geneNetworkIntervalTicks === 0) {
    try {
      const stats = await evolveNetwork();
      if (stats.new_genes > 0) log.info("evo.wiring.gene_network_evolved", stats);
    } catch (e) { log.error("evo.wiring.gene_network_err", { err: String(e) }); }
  }
  } finally { _dreamerReentrant = false; }
}

// ─── Agent turn_end ────────────────────────────────────────────────────────

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

    if (_config.backgroundReviewEnabled && _userTurnCount % _config.backgroundReviewTurnInterval === 0) {
      onTurnComplete({
        userMessage: turnEv.message.content ?? "",
        assistantMessage: turnEv.message.content ?? "",
        finalText: turnEv.message.content,
        toolIterations: turnEv.toolResults?.length ?? 0,
        interrupted: false,
        snapshot: {
          messages: [
            { role: "system" as const, content: "[INSTINCTS + BASE_PROMPT]" },
            { role: "user" as const, content: turnEv.message.content ?? "" },
          ],
          loadedSkills: [] as string[],
          toolCalls: (turnEv.toolResults ?? []).map((r) => ({
            name: r.toolName,
            arguments: JSON.stringify(r),
          })),
        },
      }).catch((e) => { log.error("evo.wiring.turn_complete_err", { err: String(e) }); });
    }
  });
  log.info("evo.wiring.agent_wired", { turnInterval: _config.backgroundReviewTurnInterval });
}

// ─── Evolution scan (disabled) ──────────────────────────────────────────────

function startEvolutionScan(): void {
  if (_config.evolutionScanIntervalMs <= 0) {
    log.info("evo.wiring.scan_disabled", { reason: "evolutionScanIntervalMs=0" });
    return;
  }
}

// ─── Master Wire ─────────────────────────────────────────────────────────────

export async function wireEvo(
  getAgentFn: () => import("@earendil-works/pi-agent-core").Agent
): Promise<void> {
  if (_wired) {
    if (_wiringPromise) return _wiringPromise;
    return;
  }
  _wired = true;
  _wiringPromise = _doWire(getAgentFn);
  return _wiringPromise;
}

async function _doWire(
  getAgentFn: () => import("@earendil-works/pi-agent-core").Agent
): Promise<void> {
  log.info("evo.wiring.start");
  // ── P0 FIX: 基因网络初始化（从未被调用！导致 _genes Map 永远为空）────
  try {
    await loadFromMemory();
    log.info("evo.wiring.loadFromMemory.ok");
  } catch (e) {
    log.warn("evo.wiring.loadFromMemory.failed", { err: String(e) });
  }
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

async function wireDreamerToCurator(): Promise<void> {
  const { Dreamer } = await import("../memory/dreamer.ts");
  const origRun = Dreamer.prototype.run as (this: object) => Promise<void>;

  // P0 FIX: 保存原始函数到 Symbol（防止 wrapper 重入）
  (Dreamer.prototype as any)[_ORIGINAL_DREAMER_RUN] = origRun;

  Dreamer.prototype.run = async function (this: object) {
    await dreamerTickWrapper.call(this);
  } as typeof origRun;

  log.info("evo.wiring.dreamer_wired", _config);
}

export function isWired(): boolean { return _wired; }
