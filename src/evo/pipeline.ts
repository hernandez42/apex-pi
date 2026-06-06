/**
 * Evolution Pipeline — 自动bug修复扫描
 *
 * 来自 pi-evo 的核心能力：
 * scanForFailures → 扫描会话目录找失败
 * runEvolutionPipeline → 生成候选patch
 * loadStore → 加载已有的进化记录
 */

export interface FailureChunk {
  session_id: string;
  timestamp: string;
  error_type: string;
  content: string;
}

export interface EvolutionBatch {
  id: string;
  failure_chunks: FailureChunk[];
  root_cause: string;
  candidate_patch: string | null;
  status: "pending" | "running" | "done" | "failed";
  delta_g: number;
  created_at: string;
  verdict: "pending" | "approved" | "rejected";
}

/**
 * 扫描会话目录，找失败的turn
 */
export async function scanForFailures(sessionDir: string): Promise<FailureChunk[]> {
  // Stub: 暂时返回空，不做主动扫描
  return [];
}

/**
 * 对单个 failure batch 运行进化 pipeline
 */
export async function runEvolutionPipeline(batch: EvolutionBatch): Promise<void> {
  // Stub: 暂时不做自动修复
  console.debug(`XUANJI pipeline: batch ${batch.id} pending`);
}

/**
 * 加载已有的进化记录
 */
export async function loadStore(): Promise<EvolutionBatch[]> {
  return [];
}