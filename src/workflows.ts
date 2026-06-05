// src/workflows.ts
//
// Durability layer backed by Absurd (https://github.com/earendil-works/absurd):
// a Postgres-native durable execution engine. When ABSURD_DATABASE_URL is
// set, long-running apex-pi operations (currently the `understand_path`
// pipeline) can be wrapped as workflows: each phase becomes a checkpoint,
// so a process crash mid-run does not lose work — the worker resumes from
// the last completed phase on the next start.
//
// Design constraints:
//   * The engine is OPT-IN. When `ABSURD_DATABASE_URL` is unset, this
//     module exposes a no-op shim and the HTTP routes return 503. The 256
//     MB memory budget is preserved for the common (non-durable) case.
//   * The `absurd-sdk` and `pg` packages are imported dynamically. If the
//     user never calls `startWorkflows()`, nothing extra is loaded.
//   * One queue per apex-pi instance (`ABSURD_QUEUE`, default
//     "apex_pi_default"). Workers are pull-based, so multiple apex-pi
//     instances can share the same queue.
//
// Known limitations:
//   * The wrapped `understand_path` workflow does 3 checkpointed steps.
//     We deliberately do not checkpoint file-level scan output — the
//     cost of `readdirSync` is dwarfed by the LLM call in step 3.
//   * Spawning tasks from HTTP is fire-and-forget: the client polls
//     `GET /v1/workflows/:id` for state. We don't yet support
//     `awaitTaskResult` blocking the request — that would hold an HTTP
//     worker hostage to a 60-second LLM call.

import { log } from "./log.ts";
import { config } from "./config.ts";

/** Snapshot of a task's state. Mirrors the shape of absurd-sdk's
 *  `TaskResultSnapshot` but keeps the dependency hidden from callers. */
export type WorkflowState =
  | { state: "pending" | "running" | "sleeping" }
  | { state: "completed"; result: unknown }
  | { state: "failed"; failure: unknown }
  | { state: "cancelled" };

export interface SpawnResult {
  taskID: string;
  runID: string;
  attempt: number;
  created: boolean;
}

/** Internal: the type of the Absurd client. We only use a narrow slice of
 *  its surface, so we keep the dependency loose (typeof import) to avoid
 *  hard-coupling the rest of the codebase to its specific build. */
type AbsurdClient = {
  spawn: (name: string, params: unknown, opts?: unknown) => Promise<SpawnResult>;
  fetchTaskResult: (id: string, opts?: unknown) => Promise<WorkflowState | null>;
  cancelTask: (id: string, queue?: string) => Promise<void>;
  startWorker: (opts?: unknown) => Promise<{ close: () => Promise<void> }>;
  close: () => Promise<void>;
};

let _client: AbsurdClient | null = null;
let _worker: { close: () => Promise<void> } | null = null;
let _starting: Promise<void> | null = null;
let _stopping: Promise<void> | null = null;

/** True if Absurd is configured AND started in this process. */
export function isDurable(): boolean {
  return _client !== null;
}

/** Start the workflow engine. Idempotent: subsequent calls return the
 *  same in-flight promise. Returns silently when ABSURD_DATABASE_URL is
 *  unset (durable mode is opt-in). */
export async function startWorkflows(): Promise<void> {
  if (_client) return;
  if (_starting) return _starting;
  const cfg = config().workflows;
  if (!cfg.enabled || !cfg.databaseUrl) {
    log.info("workflows.disabled", { reason: "ABSURD_DATABASE_URL not set" });
    return;
  }
  _starting = (async () => {
    const mod = await import("absurd-sdk");
    const { Absurd } = mod as unknown as { Absurd: new (opts: unknown) => AbsurdClient };
    _client = new Absurd({
      db: cfg.databaseUrl,
      queueName: cfg.queueName,
      log: {
        log: (...a: unknown[]) => log.info("absurd.log", { args: String(a) }),
        info: (...a: unknown[]) => log.info("absurd.info", { args: String(a) }),
        warn: (...a: unknown[]) => log.warn("absurd.warn", { args: String(a) }),
        error: (...a: unknown[]) => log.error("absurd.error", { args: String(a) }),
      },
    });
    // Register all built-in workflow handlers. New workflows are added
    // by calling `registerTask` against `_client` from a module that
    // imports this file (see src/workflows/handlers.ts).
    const { registerBuiltinHandlers } = await import("./workflows/handlers.ts");
    registerBuiltinHandlers(_client as never);
    // Ensure the queue exists. We use `createQueue` which is idempotent
    // on a duplicate call (Absurd's policy is "create or no-op").
    try {
      await (_client as unknown as { createQueue: (q?: string) => Promise<void> }).createQueue(cfg.queueName);
    } catch (e) {
      log.warn("workflows.queue.create.fail", { err: (e as Error).message });
    }
    _worker = await _client.startWorker({
      concurrency: cfg.concurrency,
      claimTimeout: cfg.claimTimeoutSec,
    });
    log.info("workflows.started", { queue: cfg.queueName, concurrency: cfg.concurrency });
  })().finally(() => {
    _starting = null;
  });
  return _starting;
}

/** Spawn a workflow by name. Returns null when the engine is disabled
 *  so callers can decide whether to run the operation inline as a
 *  fallback. */
export async function spawnWorkflow(
  name: string,
  params: unknown,
  opts?: { queue?: string; maxAttempts?: number },
): Promise<SpawnResult | null> {
  if (!_client) return null;
  return _client.spawn(name, params, opts);
}

/** Fetch the current state of a workflow. Returns null if the engine is
 *  disabled or the task does not exist. */
export async function fetchWorkflow(
  taskID: string,
  queue?: string,
): Promise<WorkflowState | null> {
  if (!_client) return null;
  return _client.fetchTaskResult(taskID, queue ? { queue } : undefined);
}

/** Cancel a workflow. No-op when the engine is disabled. */
export async function cancelWorkflow(taskID: string, queue?: string): Promise<void> {
  if (!_client) return;
  await _client.cancelTask(taskID, queue);
}

/** Stop the worker and close the connection. Safe to call multiple
 *  times. */
export async function stopWorkflows(): Promise<void> {
  if (_stopping) return _stopping;
  _stopping = (async () => {
    if (_worker) {
      try {
        await _worker.close();
      } catch (e) {
        log.warn("workflows.worker.close.fail", { err: (e as Error).message });
      }
      _worker = null;
    }
    if (_client) {
      try {
        await _client.close();
      } catch (e) {
        log.warn("workflows.client.close.fail", { err: (e as Error).message });
      }
      _client = null;
    }
    log.info("workflows.stopped");
  })().finally(() => {
    _stopping = null;
  });
  return _stopping;
}

/** Test helper: clear the cached engine so the next call to
 *  `startWorkflows()` re-imports the SDK. Used by the workflows test
 *  suite, which mocks the SDK via `bun:test` module stubbing. */
export function resetWorkflowsForTests(): void {
  _client = null;
  _worker = null;
  _starting = null;
  _stopping = null;
}
