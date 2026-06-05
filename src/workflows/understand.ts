// src/workflows/understand.ts
//
// Spawn helper for the durable `understand` workflow. Returns a taskID
// that the client polls via `GET /v1/workflows/:id`. When the workflow
// engine is disabled (no ABSURD_DATABASE_URL), the helper returns null
// and the caller falls back to the in-process `understand()`.

import { spawnWorkflow, fetchWorkflow, type WorkflowState } from "../workflows.ts";
import type { UnderstandOptions } from "../understand/pipeline.ts";

export interface SpawnedWorkflow {
  taskID: string;
  runID: string;
  attempt: number;
}

/** Spawn a durable `understand` workflow. Returns null when the engine
 *  is disabled so the caller can fall back to the inline implementation. */
export async function spawnUnderstand(opts: UnderstandOptions): Promise<SpawnedWorkflow | null> {
  const r = await spawnWorkflow("understand", opts);
  if (!r) return null;
  return { taskID: r.taskID, runID: r.runID, attempt: r.attempt };
}

/** Fetch the current state of a spawned `understand` workflow. */
export function fetchUnderstand(taskID: string): Promise<WorkflowState | null> {
  return fetchWorkflow(taskID);
}
