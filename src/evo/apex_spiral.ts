/**
 * apex_spiral.ts — ApexSpiral 5公理自我指涉引擎
 *
 * 璇玑 × APEX 融合的终极自我模型：
 *   Axiom1: 自我观察 (psiSelf) — 偏差检测
 *   Axiom2: 自我评估 (nablaSelf) — 自动微分问题发现
 *   Axiom3: 自我优化 (xiRepair) — 防漂移修复
 *   Axiom4: 自我修复 (Ω_self) — 外部反馈整合
 *   Axiom5: 自我进化 (gammaAwake) — 无限进化
 *
 * 集成点: wiring.ts 的 Dreamer tick（与 sparkRippleTick 并行）
 *
 * 公式: phiSelfLoop = psiSelf × (1+|nablaSelf|) × xiRepair × gammaAwake
 */

import { boot } from "../bootstrap.ts";
import { getMossStats } from "./moss.ts";
import { log } from "../log.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApexSpiralState {
  // Axiom1: 自我观察
  delta_g_history: number[];       // 最近N次ΔG
  avg_delta_g: number;
  variance_delta_g: number;
  trend: "rising" | "falling" | "stable";

  // Axiom2: 自我评估
  defect_score: number;            // 0..1，问题严重程度
  top_defects: string[];          // 问题列表
  self_consistency: number;       // 0..1，自我一致性

  // Axiom3: 自我优化
  repair_count: number;            // 自我修复次数
  last_repair_at: string | null;
  anti_drift_score: number;       // 防漂移能力

  // Axiom4: 自我修复
  external_feedback_count: number;
  last_external_feedback_at: string | null;
  fitness_pressure: number;       // 选择压力

  // Axiom5: 自我进化
  generation: number;              // 当前代数
  evolution_velocity: number;     // ΔG变化速度
  is_awake: boolean;               // 是否处于觉醒状态

  // 综合评分
  phi_self_loop: number;          // phiSelfLoop = Ψ×(1+|∇|)×Ξ×Γ
  overall_health: number;         // 0..1，整体健康度
}

interface ApexSpiralConfig {
  history_window: number;         // ΔG历史窗口大小 (default: 20)
  defect_threshold: number;        // 触发缺陷报告的阈值 (default: 0.5)
  repair_interval_ticks: number;  // 每N个tick触发一次修复 (default: 10)
  evolution_window: number;       // 进化速度计算窗口 (default: 50)
  self_consistency_window: number;// 一致性计算窗口 (default: 30)
}

const DEFAULT_CONFIG: ApexSpiralConfig = {
  history_window: 20,
  defect_threshold: 0.5,
  repair_interval_ticks: 10,
  evolution_window: 50,
  self_consistency_window: 30,
};

// ─── State ───────────────────────────────────────────────────────────────────

let _config: ApexSpiralConfig = { ...DEFAULT_CONFIG };
let _tick = 0;
let _state: ApexSpiralState = _blankState();
let _deltaGBuffer: number[] = [];  // 滚动ΔG历史
let _repairCount = 0;
let _externalFeedbackCount = 0;
let _lastRepairAt: string | null = null;
let _lastExternalFeedbackAt: string | null = null;
let _generation = 0;

function _blankState(): ApexSpiralState {
  return {
    delta_g_history: [],
    avg_delta_g: 0,
    variance_delta_g: 0,
    trend: "stable",
    defect_score: 0,
    top_defects: [],
    self_consistency: 1.0,
    repair_count: 0,
    last_repair_at: null,
    anti_drift_score: 1.0,
    external_feedback_count: 0,
    last_external_feedback_at: null,
    fitness_pressure: 0.5,
    generation: 0,
    evolution_velocity: 0,
    is_awake: true,
    phi_self_loop: 1.0,
    overall_health: 0.8,
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function updateApexSpiralConfig(cfg: Partial<ApexSpiralConfig>): void {
  _config = { ..._config, ...cfg };
  log.info("apex_spiral.config_updated", _config);
}

// ─── Axiom1: 自我观察 (psiSelf) — 偏差检测 ────────────────────────────────

/**
 * psiSelf = σ(Φ_APEX - E[Φ_APEX])
 * 自我感知 = sigmoid(当前效能 - 期望效能)
 * 返回 0..1，0.5=正常，>0.7=超常，<0.3=异常
 */
function computePsiSelf(currentDeltaG: number, avgDeltaG: number, variance: number): number {
  if (variance < 0.001) return 0.5; // 无方差，视为正常
  const zScore = (currentDeltaG - avgDeltaG) / Math.sqrt(variance);
  // sigmoid映射：z=0 → 0.5, z=+2 → 0.88, z=-2 → 0.12
  return 1 / (1 + Math.exp(-zScore));
}

// ─── Axiom2: 自我评估 (nablaSelf) — 问题发现 ────────────────────────────────

/**
 * nablaSelf = gradient(Defect) = 最近ΔG下降速率
 * 返回负值表示下滑，正值表示上升，0表示稳定
 */
function computeNablaSelf(buffer: number[]): number {
  if (buffer.length < 5) return 0;
  const recent = buffer.slice(-10);
  // 线性回归斜率
  const n = recent.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = recent.reduce((a, b) => a + b, 0);
  const sumXY = recent.reduce((acc, y, x) => acc + x * y, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  // 归一化到 -1..1 范围（假设ΔG典型范围0..100）
  return Math.max(-1, Math.min(1, slope / 10));
}

// ─── Axiom3: 自我优化 (xiRepair) — 防漂移 ───────────────────────────────

/**
 * xiRepair = Ω_self × (1 - ε_drift)
 * 防漂移能力 = 外部反馈整合度 × (1 - 漂移率)
 */
function computeXiRepair(externalCount: number, tick: number): number {
  if (tick === 0) return 0.5;
  const feedbackRatio = Math.min(1, externalCount / 10);
  const repairIntensity = 1 - Math.exp(-_repairCount / 5); // 修复次数越多，防漂移越强
  return 0.3 + 0.4 * feedbackRatio + 0.3 * repairIntensity;
}

// ─── Axiom4: 自我修复 — 外部反馈整合 ─────────────────────────────────────

/**
 * 每当有外部反馈（用户纠正、飞书消息评价），调用此函数记录
 */
export function recordExternalFeedback(source: string, delta: number): void {
  _externalFeedbackCount++;
  _lastExternalFeedbackAt = new Date().toISOString();
  log.info("apex_spiral.external_feedback", { source, delta, total: _externalFeedbackCount });
}

// ─── Axiom5: 自我进化 (gammaAwake) — 无限进化 ──────────────────────────────

/**
 * gammaAwake = Γ × ∞_limit
 * 进化速度 = 选择压力 × 进化极限（无上限）
 */
function computeGammaAwake(velocity: number): number {
  // velocity ∈ [-1, 1]，0=静止，1=极速上升，-1=极速下降
  // 转化到 [0.1, 2.0]
  return 0.1 + (velocity + 1) * 0.95;
}

// ─── 趋势计算 ──────────────────────────────────────────────────────────────

function computeTrend(buffer: number[]): "rising" | "falling" | "stable" {
  if (buffer.length < 5) return "stable";
  const slope = computeNablaSelf(buffer);
  if (slope > 0.1) return "rising";
  if (slope < -0.1) return "falling";
  return "stable";
}

// ─── 核心：自我评估 tick ──────────────────────────────────────────────────

/**
 * apexSpiralTick — 由 wiring.ts 的 Dreamer tick 驱动
 *
 * 流程:
 *   1. 记录当前ΔG（外部调用 recordDeltaG() 积累）
 *   2. 计算psiSelf（自我感知）
 *   3. 计算nablaSelf（问题发现）
 *   4. 计算xiRepair（防漂移）
 *   5. 计算gammaAwake（进化速度）
 *   6. 计算phiSelfLoop
 *   7. 每 N 个 tick 触发一次自我修复
 *   8. 更新整体健康度
 */
export async function apexSpiralTick(currentDeltaG?: number): Promise<ApexSpiralState> {
  _tick++;

  // ── P1 FIX: NaN/Infinity 防护 ──────────────────────────────────────────
  if (currentDeltaG !== undefined && (!Number.isFinite(currentDeltaG) || Number.isNaN(currentDeltaG))) {
    log.warn("apex_spiral.invalid_deltaG", { currentDeltaG, tick: _tick });
    currentDeltaG = undefined; // 跳过这次记录
  }

  // 1. 记录ΔG
  if (currentDeltaG !== undefined) {
    _deltaGBuffer.push(currentDeltaG);
    if (_deltaGBuffer.length > _config.evolution_window) {
      _deltaGBuffer.shift();
    }
  }

  // 2. 计算统计量
  const n = _deltaGBuffer.length;
  const avg = n > 0 ? _deltaGBuffer.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1
    ? _deltaGBuffer.reduce((acc, v) => acc + (v - avg) ** 2, 0) / n
    : 0;
  const trend = computeTrend(_deltaGBuffer);

  // 3. 计算5个公理
  const psiSelf = computePsiSelf(_deltaGBuffer.at(-1) ?? 0, avg, variance);
  const nablaSelf = computeNablaSelf(_deltaGBuffer);
  const xiRepair = computeXiRepair(_externalFeedbackCount, _tick);
  const gammaAwake = computeGammaAwake(nablaSelf);

  // 4. phiSelfLoop
  const phi_self_loop = psiSelf * (1 + Math.abs(nablaSelf)) * xiRepair * gammaAwake;

  // 5. 整体健康度（加权平均）
  const overall_health = Math.max(0, Math.min(1,
    0.3 * psiSelf +
    0.2 * (1 - Math.abs(nablaSelf)) +
    0.2 * xiRepair +
    0.15 * gammaAwake / 2 +
    0.15 * (1 - (_state.defect_score ?? 0))
  ));

  // 6. 问题发现
  const defect_score = Math.abs(nablaSelf) > _config.defect_threshold
    ? Math.abs(nablaSelf)
    : 0;

  const top_defects: string[] = [];
  if (nablaSelf < -0.3) top_defects.push("ΔG持续下滑");
  if (variance > 100) top_defects.push("ΔG波动剧烈");
  if (_externalFeedbackCount === 0 && _tick > 20) top_defects.push("无外部反馈");
  if (avg < 10) top_defects.push("ΔG过低，基因质量差");

  // 7. 定期自我修复（每N个tick）
  if (_tick % _config.repair_interval_ticks === 0 && defect_score > 0) {
    _repairCount++;
    _lastRepairAt = new Date().toISOString();
    log.info("apex_spiral.self_repair", {
      tick: _tick,
      defect_score,
      defects: top_defects,
      repair_count: _repairCount,
    });
  }

  // 8. 更新状态
  _state = {
    delta_g_history: [..._deltaGBuffer],
    avg_delta_g: avg,
    variance_delta_g: variance,
    trend,
    defect_score,
    top_defects,
    self_consistency: 1 - Math.abs(nablaSelf) * 0.5,
    repair_count: _repairCount,
    last_repair_at: _lastRepairAt,
    anti_drift_score: xiRepair,
    external_feedback_count: _externalFeedbackCount,
    last_external_feedback_at: _lastExternalFeedbackAt,
    fitness_pressure: Math.abs(nablaSelf) * gammaAwake,
    generation: _generation,
    evolution_velocity: nablaSelf,
    is_awake: overall_health > 0.3,
    phi_self_loop,
    overall_health,
  };

  // 9. 日志（每10个tick输出一次完整状态）
  if (_tick % 10 === 0) {
    log.info("apex_spiral.tick", {
      tick: _tick,
      phi_self_loop: Math.round(phi_self_loop * 100) / 100,
      overall_health: Math.round(overall_health * 100) / 100,
      avg_delta_g: Math.round(avg * 10) / 10,
      trend,
      defects: top_defects.length,
      repairs: _repairCount,
    });
  }

  return _state;
}

// ─── 外部接口 ─────────────────────────────────────────────────────────────

/**
 * 记录一次ΔG值（由 background-review.ts 或 agent.ts 调用）
 */
export function recordDeltaG(deltaG: number): void {
  _deltaGBuffer.push(deltaG);
  if (_deltaGBuffer.length > _config.evolution_window) {
    _deltaGBuffer.shift();
  }
}

/**
 * 获取当前自我状态（供 agent.ts 注入上下文）
 */
export function getApexSpiralState(): ApexSpiralState {
  return { ..._state };
}

/**
 * 获取简短的自我状态描述（供 systemPrompt 注入）
 */
export function getSelfDescription(): string {
  if (_tick === 0) {
    return "[APEX SPIRAL] 尚未初始化，首次交互后将生成自我模型。";
  }
  const s = _state;
  const healthPct = Math.round(s.overall_health * 100);
  const phiPct = Math.round(s.phi_self_loop * 100);
  const defectList = s.top_defects.length > 0
    ? `当前问题: ${s.top_defects.join(", ")}。`
    : "无检测到的问题。";

  return `[APEX SPIRAL 自我评估]
- 整体健康度: ${healthPct}%
- 自我循环因子(phiSelfLoop): ${phiPct}%
- ΔG均值: ${Math.round(s.avg_delta_g)}（趋势: ${s.trend}）
- 自我修复次数: ${s.repair_count}
- 外部反馈数: ${s.external_feedback_count}
- ${defectList}
- 进化速度: ${s.evolution_velocity > 0 ? "↑上升" : s.evolution_velocity < 0 ? "↓下降" : "→稳定"}`;
}

/**
 * 重置状态（测试用）
 */
export function resetApexSpiral(): void {
  _tick = 0;
  _state = _blankState();
  _deltaGBuffer = [];
  _repairCount = 0;
  _externalFeedbackCount = 0;
  _lastRepairAt = null;
  _lastExternalFeedbackAt = null;
  _generation = 0;
  log.info("apex_spiral.reset");
}