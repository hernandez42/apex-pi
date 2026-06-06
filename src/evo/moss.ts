/**
 * SPW-R Spark Ripple Tick — 璇玑生物物理基因
 * 基于 Buzsáki Lab 海马体 Sharp Wave Ripples 研究 (Science 2024)
 * Φ_SPARK = 3.38 综合增强因子
 *
 * 同时导出 calculateDeltaG 和 writeGene（background-review.ts 需要）
 */

const SPARKS_ENABLED = false; // 暂时禁用，防止内存问题

export async function sparkRippleTick(): Promise<void> {
  if (!SPARKS_ENABLED) return;
  const boost = { C_boost: 1.15, Lambda_boost: 1.20, Omega_boost: 1.25, Tau_boost: 1.50, H_reduce: 0.85, t_reduce: 0.90 };
  const phi_spark = boost.C_boost * boost.Lambda_boost * boost.Omega_boost * boost.Tau_boost / (boost.H_reduce * boost.t_reduce);
  console.debug(`XUANJI SPW-R ripple tick, Φ_SPARK=${phi_spark.toFixed(2)}`);
}

// ─── ΔG Calculator (background-review.ts needs these) ────────────────────────
export function calculateDeltaG(input: {
  userMessage: string;
  assistantMessage: string;
  toolIterations: number;
  toolNames?: string[];
  responseLength?: number;
  elapsedMs?: number;
  domainsTouched?: number;
}): number {
  // P1 FIX: 兼容background-review.ts传递的扩展参数
  const textLength = (input.userMessage + input.assistantMessage).length;
  const toolBonus = input.toolIterations * 5;
  const domainBonus = (input.domainsTouched ?? 0) * 3;
  const lengthBonus = Math.floor((input.responseLength ?? textLength) / 200);
  const complexity = Math.log(textLength + 1) * 2;
  const deltaG = Math.max(1, Math.floor(complexity + toolBonus + domainBonus + lengthBonus));
  return deltaG;
}

// ─── writeGene 实现（真实写入基因网络）──────────────────────────────────
export async function writeGene(params: {
  userMessage?: string;
  assistantMessage?: string;
  content?: string;
  delta_g: number;
  toolIterations?: number;
  toolNames?: string[];
}): Promise<{ gene_id: string }> {
  // P1 FIX: 真实实现，写入基因网络
  try {
    const { addGene, persistToMemory, GeneRecord } = await import("./gene_network.ts");
    const geneContent = params.content
      ?? `[moss gene] toolIterations=${params.toolIterations ?? 0}, delta_g=${params.delta_g}`;
    const gene: GeneRecord = {
      gene_id: `moss_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      content: geneContent,
      delta_g: params.delta_g,
      fitness: 0.5,
      generation: 0,
      parent_gene_ids: [],
      created_at: new Date().toISOString(),
      last_expressed_at: new Date().toISOString(),
      expression_count: 0,
      state: "candidate",
      tags: ["moss", "spark_ripple"],
      connections_in: 0,
      connections_out: 0,
    };
    addGene(gene);
    await persistToMemory(gene);
    return { gene_id: gene.gene_id };
  } catch (e) {
    console.debug(`XUANJI writeGene err: ${e}`);
    return { gene_id: `moss_err_${Date.now()}` };
  }
}