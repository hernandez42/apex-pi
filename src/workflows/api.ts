import { Hono } from "hono";
import { isAbsolute, resolve } from "node:path";
import { isDurable, spawnWorkflow, fetchWorkflow, cancelWorkflow } from "../workflows.ts";
import { log } from "../log.ts";
import { config } from "../config.ts";
import { understand } from "../understand/index.ts";

const DISABLED = (c: { json: (v: unknown, s?: number) => Response }) =>
  c.json({ error: "workflows disabled — set ABSURD_DATABASE_URL" }, 503);

export function mountWorkflows(app: Hono): void {
  // ─── list ─────────────────────────────────────────────────────────
  app.get("/v1/workflows", (c) => {
    return c.json({ workflows: ["understand", "apex_distill"] });
  });

  // ─── understand ───────────────────────────────────────────────────
  app.post("/v1/workflows/understand", async (c) => {
    if (!isDurable()) return DISABLED(c);
    const body = await c.req.json<{
      path: string;
      max_files?: number;
      max_file_kb?: number;
      focus?: string;
      graph_only?: boolean;
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

  // ─── apex_distill ─────────────────────────────────────────────────
  app.post("/v1/workflows/distill", async (c) => {
    if (!isDurable()) return DISABLED(c);
    const body = await c.req.json<{
      name: string;
      steps: Array<{ tool: string; input?: unknown; output?: string }>;
      when_to_use?: string;
      skills_dir?: string;
    }>();
    if (!body.name) return c.json({ error: "name is required" }, 400);
    if (!body.steps || body.steps.length === 0) {
      return c.json({ error: "steps must contain at least 1 entry" }, 400);
    }
    const skillsDir = body.skills_dir
      ? (isAbsolute(body.skills_dir) ? body.skills_dir : resolve(body.skills_dir))
      : config().skills.dir;
    if (!skillsDir) {
      return c.json({ error: "skillsDir is required (set SKILLS_DIR or pass skills_dir)" }, 400);
    }
    const spawn = await spawnWorkflow("apex_distill", {
      name: body.name,
      steps: body.steps,
      skillsDir,
      whenToUse: body.when_to_use,
    });
    if (!spawn) return DISABLED(c);
    log.info("workflows.spawn", { task: "apex_distill", id: spawn.taskID, name: body.name, steps: body.steps.length });
    return c.json({
      mode: "durable",
      task_id: spawn.taskID,
      run_id: spawn.runID,
      attempt: spawn.attempt,
      queue: config().workflows.queueName,
      poll: `GET /v1/workflows/${spawn.taskID}`,
    });
  });

  // ─── get / cancel ─────────────────────────────────────────────────
  app.get("/v1/workflows/:id", async (c) => {
    if (!isDurable()) return DISABLED(c);
    const id = c.req.param("id");
    const queue = c.req.query("queue") ?? undefined;
    const snap = await fetchWorkflow(id, queue);
    if (!snap) return c.json({ error: "task not found" }, 404);
    return c.json({ task_id: id, ...snap });
  });

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
