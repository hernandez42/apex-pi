/**
 * pi-evo Background Review Fork — hermes-agent 风格深度集成.
 *
 * 在每个 turn 完成后,spawn 一个 forked apex-pi agent 来:
 *   1. Memory Review: 值得记住什么?
 *   2. Skill Review: 值得更新/创建什么技能?
 *
 * 这个 fork 不会阻塞主循环 — 它在后台 daemon thread 中运行.
 * 工具白名单限制为 memory + skill_manage + todo,不会修改主对话.
 *
 * 集成点: agent.ts 的 afterTurnComplete 钩子.
 */

import { getMemoryEngine } from "../memory/index.ts";
import { boot } from "../bootstrap.ts";
import { getAgent } from "../agent.ts";
import { log } from "../log.ts";
import { eccInstincts } from "./instincts.ts";
import { calculateDeltaG, writeGene } from "./moss.ts";
import { addGene, persistToMemory, getGeneNetworkStats } from "./gene_network.ts";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

// ─── Review Prompts (from hermes-agent background_review.py) ───────────────────

const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires,
   preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work
   style, or ways they want you to operate?

If something stands out, save it using the memory tool.
If nothing is worth saving, just say 'Nothing to save.' and stop.`;

const SKILL_REVIEW_PROMPT = `Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md and a \`references/\` directory for session-specific detail. Not a long flat list of narrow one-session-one-skill entries.

Signals to look for (any one of these warrants action):
  • User corrected your style, tone, format, verbosity, or legibility.
    Frustration signals like 'stop doing X', 'this is too verbose', 'don't format like this',
    'why are you explaining', 'just give me the answer', 'you always do Y and I hate it',
    or an explicit 'remember this' are FIRST-CLASS skill signals.
  • User corrected your workflow, approach, or sequence of steps.
    Encode the correction as a pitfall or explicit step in the skill.
  • Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged.
  • A skill that got loaded or consulted this session turned out to be wrong, missing a step, or outdated. Patch it NOW.

Preference order:
  1. UPDATE a currently-loaded skill first. If it covers the territory, patch it.
  2. UPDATE an existing umbrella skill. Add a subsection, pitfall, or broaden trigger.
  3. ADD a support file under an existing umbrella:
     • \`references/<topic>.md\` — session-specific detail, error transcripts
     • \`templates/<name>.<ext>\` — starter files
     • \`scripts/<name>.<ext>\` — re-runnable verification scripts
  4. CREATE a new class-level umbrella skill when no existing skill covers the class.

User-preference embedding: when the user expressed a style/format/workflow preference,
the update belongs in the SKILL.md body, not just in memory. Skills capture 'how to do
this class of task for this user'.

Protected skills (DO NOT edit):
  • Bundled skills (shipped with apex-pi).
  • Hub-installed skills (installed via apex-pi skills install).
Pinned skills CAN be improved — pin only blocks deletion/archive/consolidation.

Do NOT capture:
  • Environment-dependent failures (missing binaries, 'command not found').
  • Negative claims about tools ('X tool is broken').
  • One-off task narratives that aren't a class of work.

If the only skills that need updating are protected, say 'Nothing to save.' and stop.`;

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface ReviewConfig {
  memory_interval_turns: number;  // 每 N 个 user turns 检查一次 memory
  skill_interval_iters: number;   // 每 N 个 tool iterations 检查 skills
  fork_model?: string;            // forked agent 使用的模型 (可选)
  enabled?: boolean;
}

const DEFAULT_CONFIG: ReviewConfig = {
  memory_interval_turns: 3,
  skill_interval_iters: 50,
  enabled: true,
};

// ─── State tracking ───────────────────────────────────────────────────────────

let _userTurnCount = 0;
let _toolIterations = 0;
let _itersSinceSkill = 0;
let _config: ReviewConfig = { ...DEFAULT_CONFIG };

export function updateConfig(cfg: Partial<ReviewConfig>): void {
  _config = { ..._config, ...cfg };
}

export function onTurnComplete(turn: TurnSnapshot): void {
  if (!_config.enabled) return;

  _userTurnCount++;
  _toolIterations += turn.toolIterations ?? 0;
  _itersSinceSkill += turn.toolIterations ?? 0;

  const shouldReviewMemory = _userTurnCount % _config.memory_interval_turns === 0;
  const shouldReviewSkills = (
    _config.skill_interval_iters > 0 &&
    _itersSinceSkill >= _config.skill_interval_iters
  );

  if (shouldReviewSkills) _itersSinceSkill = 0;

  // ── P1: Gene维 写入 — 璇玑公式 ΔG 计算 ──
  const instincts = eccInstincts();
  if (!turn.interrupted && turn.userMessage) {
    try {
      const deltaG = calculateDeltaG({
        userMessage: turn.userMessage,
        toolIterations: turn.toolIterations,
        toolNames: turn.snapshot?.toolCalls?.map(tc => tc.name) ?? [],
        responseLength: (turn.finalText ?? turn.assistantMessage).length,
        elapsedMs: 0, // 近似值
        domainsTouched: new Set(turn.snapshot?.toolCalls?.map(tc => tc.name.split(/[-_]/)[0])).size,
      });

      if (deltaG >= 30) { // ΔG >= 30 才写基因（降低噪声）
        const geneContent = `[Turn ${_userTurnCount}]
USER: ${turn.userMessage.slice(0, 500)}
ASSISTANT: ${(turn.finalText ?? turn.assistantMessage).slice(0, 500)}
Tools used: ${(turn.snapshot?.toolCalls ?? []).map(tc => tc.name).join(", ") || "none"}`;

        // Fire-and-forget async IIFE to avoid blocking the sync call path
        void (async () => {
          try {
            const mod = await import("./gene_network.ts");
            const GeneRecord = mod.GeneRecord;
            const gene: GeneRecord = {
              gene_id: `br_${Date.now()}_${_userTurnCount}`,
              content: geneContent,
              delta_g: deltaG,
              fitness: 0.5,
              generation: 0,
              parent_gene_ids: [],
              created_at: new Date().toISOString(),
              last_expressed_at: new Date().toISOString(),
              expression_count: 0,
              state: "candidate",
              tags: ["background_review", `delta_g_${deltaG}`],
              connections_in: 0,
              connections_out: 0,
            };
            mod.addGene(gene);
            mod.persistToMemory(gene).catch((e: Error) => log.warn("background_review.gene_persist_err", { err: String(e) }));
            log.info("evo.background_review.gene_written", { turn: _userTurnCount, delta_g: deltaG, gene_id: gene.gene_id });
          } catch (e) {
            log.debug("background_review.gene_calc_err", { err: String(e) });
          }
        })();

        // Also write via moss.ts (dual write for redundancy, async but fire-and-forget)
        writeGene({
          userMessage: turn.userMessage,
          assistantMessage: turn.assistantMessage,
          delta_g: deltaG,
          toolIterations: turn.toolIterations,
          toolNames: turn.snapshot?.toolCalls?.map(tc => tc.name) ?? [],
        }).catch((e: Error) => log.debug("background_review.write_gene_err", { err: String(e) }));
      }
    } catch (e) {
      log.debug("background_review.gene_calc_err", { err: String(e) });
    }
  }

  if ((shouldReviewMemory || shouldReviewSkills) && !turn.interrupted && turn.finalText) {
    // Fire and forget — don't block the main loop
    spawnBackgroundReviewFork({
      memory_review: shouldReviewMemory,
      skill_review: shouldReviewSkills,
      conversationSnapshot: turn.snapshot,
      finalText: turn.finalText,
    }).catch((e) => {
      log.error("evo.background_review.fork_failed", { err: String(e) });
    });
  }
}

export function onTurnInterrupt(): void {
  _userTurnCount++;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TurnSnapshot {
  userMessage: string;
  assistantMessage: string;
  finalText?: string;
  toolIterations: number;
  interrupted: boolean;
  snapshot: AgentTurnSnapshot;
}

export interface AgentTurnSnapshot {
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  loadedSkills: string[];
  toolCalls: Array<{ name: string; arguments: string }>;
}

// ─── Background Review Fork ───────────────────────────────────────────────────

export async function spawnBackgroundReviewFork(ctx: {
  memory_review: boolean;
  skill_review: boolean;
  conversationSnapshot: AgentTurnSnapshot;
  finalText: string;
}): Promise<void> {
  log.info("evo.background_review.spawn", {
    memory: ctx.memory_review,
    skill: ctx.skill_review,
    msg_count: ctx.conversationSnapshot.messages.length,
  });

  // Fork: spawn a separate apex-pi agent in a background task
  // The forked agent has its own conversation context
  const forkAgent = await import("../agent.ts").then((m) => m.getAgent());

  // Build review prompt from conversation
  const messages = ctx.conversationSnapshot.messages;
  const reviewUserMsg = buildReviewMessage(messages, ctx.memory_review, ctx.skill_review);

  let fullResponse = "";
  const sub = forkAgent.subscribe((ev: AgentEvent) => {
    if (ev.type === "message_update") {
      const mue = (ev as { assistantMessageEvent?: { type: string; delta?: string } })
        .assistantMessageEvent;
      if (mue?.type === "text_delta" && mue.delta) {
        fullResponse += mue.delta;
      }
    }
  });

  try {
    await forkAgent.prompt(reviewUserMsg);
    log.info("evo.background_review.done", {
      memory: ctx.memory_review,
      skill: ctx.skill_review,
      response_length: fullResponse.length,
    });

    // ── P2: 从 review 结果中提取候选基因 ──
    // 如果 review 发现有价值的内容，生成候选基因
    if (fullResponse.length > 200 && !fullResponse.includes("Nothing to save")) {
      try {
        const { GeneRecord } = await import("./gene_network.ts");
        const reviewGene: GeneRecord = {
          gene_id: `review_${Date.now()}`,
          content: fullResponse.slice(0, 1000),
          delta_g: Math.floor(fullResponse.length / 50), // 粗估ΔG
          fitness: 0.5,
          generation: 0,
          parent_gene_ids: [],
          created_at: new Date().toISOString(),
          last_expressed_at: new Date().toISOString(),
          expression_count: 0,
          state: "candidate",
          tags: ["skill_review", "background_review"],
          connections_in: 0,
          connections_out: 0,
        };
        addGene(reviewGene);
        persistToMemory(reviewGene).catch(() => {});
        log.info("evo.background_review.review_gene_added", { gene_id: reviewGene.gene_id });
      } catch (e) {
        log.debug("background_review.review_gene_err", { err: String(e) });
      }
    }
  } catch (e) {
    log.error("evo.background_review.error", { err: String(e) });
  } finally {
    sub();
  }
}

function buildReviewMessage(
  messages: AgentTurnSnapshot["messages"],
  doMemory: boolean,
  doSkills: boolean,
): string {
  const parts: string[] = [];

  // Build conversation context (last N messages to stay within context window)
  const recent = messages.slice(-20);
  parts.push("=== Recent Conversation ===\n");
  for (const msg of recent) {
    const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
    parts.push(`[${role}]\n${msg.content.slice(0, 500)}\n`);
  }

  if (doMemory) {
    parts.push(`\n=== Memory Review Task ===\n${MEMORY_REVIEW_PROMPT}\n`);
  }
  if (doSkills) {
    parts.push(`\n=== Skill Review Task ===\n${SKILL_REVIEW_PROMPT}\n`);
  }

  return parts.join("\n");
}

// ─── Skill Review: Check if loaded skill needs patching ───────────────────────

/**
 * After each turn, check if any loaded skill was consulted and should be patched.
 * This runs synchronously (not in a fork) for fast feedback.
 */
export async function checkLoadedSkills(
  loadedSkills: string[],
  conversationContext: string,
): Promise<void> {
  const instincts = eccInstincts();
  const engine = getMemoryEngine(boot().store);

  for (const skillName of loadedSkills) {
    // Check if the skill's content matches the conversation
    // If user corrected something about this skill's domain, patch it
    const correctionSignals = [
      "stop doing", "don't", "this is wrong", "you always",
      "why are you", "too verbose", "just give me",
    ];

    const hasCorrection = correctionSignals.some((sig) =>
      conversationContext.toLowerCase().includes(sig)
    );

    if (hasCorrection) {
      // Flag this skill for review in next curator cycle
      await engine.ingest({
        dimension: "procedural",
        content: JSON.stringify({
          type: "skill_review_flag",
          skill: skillName,
          reason: "user_correction_signal",
          context: conversationContext.slice(-200),
          timestamp: new Date().toISOString(),
        }),
        tags: ["evolution", "skill_review_flag"],
      });
    }
  }
}

// ─── Memory Review: Extract user preferences ──────────────────────────────────

/**
 * After each turn, check if user revealed personal info worth remembering.
 * Uses ECC Instincts SECURITY to avoid capturing sensitive data.
 */
export async function checkMemoryWorthiness(
  messages: AgentTurnSnapshot["messages"],
): Promise<void> {
  const instincts = eccInstincts();
  const engine = getMemoryEngine(boot().store);

  // Check most recent user message for personal info signals
  const recentUser = messages.filter((m) => m.role === "user").slice(-3);

  for (const msg of recentUser) {
    const content = msg.content;

    // SECURITY check: don't capture credentials or sensitive info
    if (!instincts.SECURITY(content)) continue;

    // Signals worth saving to memory
    const personalSignals = [
      /i (prefer|like|hate|love|dislike)/i,
      /my (project|code|repo|workflow)/i,
      /i'm working on/i,
      /please remember/i,
      /i usually (do|use|run)/i,
    ];

    const hasPersonal = personalSignals.some((re) => re.test(content));
    if (hasPersonal && content.length > 20 && content.length < 1000) {
      await engine.ingest({
        dimension: "episodic",
        content: JSON.stringify({
          type: "user_preference",
          content: content,
          source: "background_review",
          timestamp: new Date().toISOString(),
        }),
        tags: ["user_preference", "memory_review"],
      });
    }
  }
}