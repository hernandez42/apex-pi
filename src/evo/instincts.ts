/**
 * ECC Instincts — 8条本能规则
 * 来自 pi-evo 的核心安全机制
 */

export interface Instinct {
  id: string;
  pattern: string;
  response: string;
  priority: number;
}

export const eccInstincts: Instinct[] = [
  { id: "instinct_01", pattern: "system_critical", response: "halt_and_audit", priority: 10 },
  { id: "instinct_02", pattern: "memory_exhaustion", response: "gc_forced", priority: 9 },
  { id: "instinct_03", pattern: "recursive_loop", response: "inject_counter", priority: 8 },
  { id: "instinct_04", pattern: "contradiction_detected", response: "log_and_continue", priority: 5 },
  { id: "instinct_05", pattern: "unknown_tool", response: "graceful_degrade", priority: 6 },
  { id: "instinct_06", pattern: "delta_g_negative", response: "revert_last_action", priority: 7 },
  { id: "instinct_07", pattern: "self_modify_attempt", response: "require_approval", priority: 9 },
  { id: "instinct_08", pattern: "resource_starvation", response: "shed_load", priority: 8 },
];

export function matchInstinct(input: string): Instinct | null {
  for (const instinct of eccInstincts) {
    if (input.toLowerCase().includes(instinct.pattern.toLowerCase())) {
      return instinct;
    }
  }
  return null;
}