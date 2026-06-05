// src/workflows/distill.ts
//
// Spawn helper for the durable `apex_distill` workflow. Takes the same
// shape as the in-process `apex_distill` tool plus an explicit
// `skillsDir` (the worker has no `config()` of its own).

import { spawnWorkflow, fetchWorkflow, type WorkflowState } from "../workflows.ts";
import type { DistillParams, DistillResult } from "./handlers.ts";

export interface SpawnedDistill {
  taskID: string;
  runID: string;
  attempt: number;
}

/** Spawn a durable `apex_distill` workflow. Returns null when the engine
 *  is disabled so the caller can fall back to the in-process
 *  `apex_distill` tool. */
export async function spawnDistill(params: DistillParams): Promise<SpawnedDistill | null> {
  const r = await spawnWorkflow("apex_distill", params);
  if (!r) return null;
  return { taskID: r.taskID, runID: r.runID, attempt: r.attempt };
}

/** Fetch the current state of a spawned `apex_distill` workflow. */
export function fetchDistill(taskID: string): Promise<WorkflowState | null> {
  return fetchWorkflow(taskID);
}

export type { DistillParams, DistillResult };
