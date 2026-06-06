export type InstinctAction =
  | "shed_load"
  | "halt_revert"
  | "adaptive_throttle"
  | "emergency_reboot";

export interface InstinctRule {
  id: string;
  trigger: string;
  priority: number;
  action: InstinctAction;
}

export interface InstinctMatch extends InstinctRule {
  matched: boolean;
}

export const INSTINCT_RULES: InstinctRule[] = [
  {
    id: "instinct_01",
    trigger: "memory_exhaustion",
    priority: 10,
    action: "shed_load",
  },
  {
    id: "instinct_02",
    trigger: "recursive_loop",
    priority: 9,
    action: "halt_revert",
  },
  {
    id: "instinct_03",
    trigger: "circuit_breaker_tripped",
    priority: 10,
    action: "shed_load",
  },
  {
    id: "instinct_04",
    trigger: "confidence_collapse",
    priority: 5,
    action: "adaptive_throttle",
  },
  {
    id: "instinct_05",
    trigger: "capability_degradation",
    priority: 5,
    action: "adaptive_throttle",
  },
  {
    id: "instinct_06",
    trigger: "system_critical_failure",
    priority: 7,
    action: "emergency_reboot",
  },
  {
    id: "instinct_07",
    trigger: "divergence_detected",
    priority: 6,
    action: "halt_revert",
  },
  {
    id: "instinct_08",
    trigger: "contradiction_detected",
    priority: 4,
    action: "adaptive_throttle",
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordBoundaryMatch(input: string, trigger: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, "i");
  return pattern.test(input);
}

export function matchInstincts(input: string): InstinctRule[] {
  return INSTINCT_RULES.filter((rule) =>
    hasWordBoundaryMatch(input, rule.trigger),
  ).sort((a, b) => b.priority - a.priority);
}

export function resolveInstinct(input: string): InstinctRule | null {
  return matchInstincts(input)[0] ?? null;
}

export function getInstinctAction(input: string): InstinctAction | null {
  return resolveInstinct(input)?.action ?? null;
}
// Backward compat: eccInstincts() returns all rules (original interface)
// New code should use resolveInstinct() / matchInstincts() for priority-aware matching
export function eccInstincts(): Array<{ id: string; pattern: string; priority: number; action: string }> {
  return INSTINCT_RULES.map((r) => ({ id: r.id, pattern: r.trigger, priority: r.priority, action: r.action }));
}
