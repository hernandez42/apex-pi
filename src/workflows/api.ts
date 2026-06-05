// src/workflows/api.ts
//
// HTTP surface for the durable workflow engine. When the engine is
// disabled, every endpoint returns 503 with a hint to set
// `ABSURD_DATABASE_URL`. Endpoints are intentionally small — apex-pi
// follows the "thin server, fat client" pattern; the actual workflow
// spawning and result interpretation lives in extension code.

import type { Hono } from "hono";
import { isAbsolute, resolve } from "node:path";
import { isDurable, spawnWorkflow, fetchWorkflow, cancelWorkflow } from "../workflows.ts";
import { log } from "../log.ts";
import { config } from "../config.ts";
import { understand } from "../understand/pipeline.ts";

const DISABLED = (c: { json: (v: unknown, s?: number) => Response }) =>
  c.json(
    {
      error: "workflows disabled",
      reason: "set ABSURD_DATABASE_URL (and optionally ABSURD_QUEUE) to enable durable workflows",
    },
    503,
  );

export function mountWorkflows(app: Hono): void {
  // List the workflows this engine can run. Useful for clients that want
  // to introspect capabilities without reading the source.
  app.get("/v1/workflows", (c) => {
    if (!isDurable()) return DISABLED(c);
    return c.json({ workflows: ["understand", "apex_distill"] });
  });

  // Spawn a workflow. Currently only `understand` is exposed — the
  // understand pipeline is the only multi-step operation long enough
  // to benefit from durability.
  app.post("/v1/workflows/understand", async (c) => {
    if (!isDurable()) return DISABLED(c);
    const body = await c.req.json<{
      path: string;
      max_files?: number;
      max_file_kb?: number;
      focus?: string;
      graph_only?: boolean;
      /** When true, run the operation inline (non-durable fallback)
       *  even if the engine is enabled. Useful for tests and small repos. */
      inline?: boolean;
    }>();
    if (!body.path) return c.json({ error: "path is required" }, 400);
    const root = isAbsolute(body.path) ? body.path : resolve(body.path);
    const opts = {
      root,
      maxFiles: body.max_files,
      maxFileKb: body.max_file_kb,
      focus: body.focus,
      graphOnly: body.graph_only,
    };
    if (body.inline) {
      try {
        const result = await understand(opts);
        return c.json({ mode: "inline", result });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 500);
      }
    }
    const spawn = await spawnWorkflow("understand", opts);
    if (!spawn) return DISABLED(c);
    log.info("workflows.spawn", { task: "understand", id: spawn.taskID, root });
    return c.json({
      mode: "durable",
      task_id: spawn.taskID,
      run_id: spawn.runID,
      attempt: spawn.attempt,
      queue: config().workflows.queueName,
      poll: `GET /v1/workflows/${spawn.taskID}`,
    });
  });

  // Fetch a workflow's current state. The response is a passthrough of
  // the engine's snapshot (one of pending | running | sleeping |
  // completed | failed | cancelled) plus a `task_id` for correlation.
  app.get("/v1/workflows/:id", async (c) => {
    if (!isDurable()) return DISABLED(c);
    const id = c.req.param("id");
    const queue = c.req.query("queue") ?? undefined;
    const snap = await fetchWorkflow(id, queue);
    if (!snap) return c.json({ error: "task not found" }, 404);
    return c.json({ task_id: id, ...snap });
  });

  // Cancel a running workflow. No-op for terminal tasks (cancelled is
  // a no-op; completed/failed return 409).
  app.post("/v1/workflows/:id/cancel", async (c) => {
    if (!isDurable()) return DISABLED(c);
    const id = c.req.param("id");
    const queue = c.req.query("queue") ?? undefined;
    const snap = await fetchWorkflow(id, queue);
    if (!snap) return c.json({ error: "task not found" }, 404);
    if (snap.state === "completed" || snap.state === "failed" || snap.state === "cancelled") {
      return c.json({ error: "task is in terminal state", state: snap.state }, 409);
    }
    await cancelWorkflow(id, queue);
    return c.json({ task_id: id, cancelled: true });
  });
}
