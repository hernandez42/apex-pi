// src/memory/types.ts
// Memory dimensions and record shape, kept wire-compatible with the Rust apex-mem.

export type MemoryDimension = "working" | "episodic" | "semantic" | "procedural" | "declarative";

export interface MemoryRecord {
  id: string;
  dimension: MemoryDimension;
  content: string;
  tags: string[];
  importance: number; // 0..1
  createdAt: number; // epoch ms
  accessedAt: number; // epoch ms
  accessCount: number;
  decayUntil: number; // epoch ms
  hash: string; // sha1 of content for dedup
  meta?: Record<string, unknown>;
}

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
  sources: Array<"bm25" | "graph" | "lexical" | "recency">;
}

export interface IngestInput {
  content: string;
  dimension: MemoryDimension;
  tags?: string[];
  importance?: number;
  meta?: Record<string, unknown>;
  /** explicit ids (rare) */
  id?: string;
}

export interface SearchInput {
  query: string;
  topK?: number;
  dimensions?: MemoryDimension[];
  expandGraph?: boolean;
  expandDepth?: number;
}

export interface MemoryStats {
  total: number;
  byDimension: Record<MemoryDimension, number>;
  graphNodes: number;
  graphEdges: number;
  ftsSize: number;
  lastDreamAt: number | null;
}

export interface MemoryHealth {
  total: number;
  duplicates: number;
  missingEmbeddings: number;
  danglingEdges: number;
  workingBloat: number;
  deltaG: number; // -1..1, higher = healthier
  issues: string[];
}

/** default decay windows in ms (matches Rust apex-mem) */
export const DEFAULT_DECAY_MS: Record<MemoryDimension, number> = {
  working: 1 * 60 * 60 * 1000,
  episodic: 7 * 24 * 60 * 60 * 1000,
  semantic: 180 * 24 * 60 * 60 * 1000,
  procedural: 365 * 24 * 60 * 60 * 1000,
  declarative: 5 * 365 * 24 * 60 * 60 * 1000,
};
