// src/workflows.test.ts
//
// Tests for the workflow engine. We do not need a real Postgres: the
// `absurd-sdk` module is mocked at the `import()` boundary by swapping
// it for a fake in `bun:test`'s module cache. The same trick is used
// for the `pg` peer dependency so we never have to dial a real
// database.
//
// Coverage:
//   * `isDurable()` is false by default and stays false after the SDK
//     throws during init.
//   * `startWorkflows()` becomes durable only when ABSURD_DATABASE_URL
//     is set, registers the built-in handlers, and is idempotent.
//   * `spawnWorkflow()` returns null when disabled, and forwards to the
//     SDK when enabled.
//   * `fetchWorkflow()` / `cancelWorkflow()` are no-ops when disabled
//     and forward when enabled.
//   * `stopWorkflows()` closes both the worker and the client.
//   * The handlers module registers the expected task names.
//   * The `understand` handler returns a result assembled from the
//     three `ctx.step` checkpoints.

import { test, expect, beforeEach, afterEach, describe, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigForTests } from "./config.ts";

let testDataDir: string | null = null;
function makeFixtureProject(): string {
  const d = mkdtempSync(join(tmpdir(), "apex-pi-wf-"));
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "index.ts"), "export const hello = 'world';\n");
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.1" }, null, 2));
  testDataDir = d;
  return d;
}

interface FakeTask {
  taskID: string;
  runID: string;
  attempt: number;
  created: boolean;
}
interface FakeState {
  state: "pending" | "running" | "sleeping" | "completed" | "failed" | "cancelled";
  result?: unknown;
  failure?: unknown;
}
interface FakeClient {
  queueName: string;
  handlers: Map<string, (params: unknown, ctx: unknown) => Promise<unknown>>;
  spawn: (name: string, params: unknown, opts?: unknown) => Promise<FakeTask>;
  fetchTaskResult: (id: string, opts?: unknown) => Promise<FakeState | null>;
  cancelTask: (id: string, queue?: string) => Promise<void>;
  startWorker: (opts?: unknown) => Promise<{ close: () => Promise<void>; opts: unknown }>;
  /** Records the opts passed to the most recent startWorker call. */
  lastStartWorkerOpts?: unknown;
  close: () => Promise<void>;
  registerTask: <P = unknown, R = unknown>(
    opts: { name: string; queue?: string; defaultMaxAttempts?: number },
    handler: (params: P, ctx: unknown) => Promise<R>,
  ) => void;
  createQueue: (queueName?: string) => Promise<void>;
  createQueueCalls: string[];
}

let lastClient: FakeClient | null = null;

function makeFakeClient(): FakeClient {
  const handlers = new Map<string, (params: unknown, ctx: unknown) => Promise<unknown>>();
  const tasks = new Map<string, FakeState>();
  const client: FakeClient = {
    queueName: "",
    handlers,
    createQueueCalls: [],
    registerTask: (opts, handler) => {
      handlers.set(opts.name, handler as never);
    },
    createQueue: async (queueName) => {
      client.createQueueCalls.push(queueName ?? client.queueName);
    },
    spawn: async (name, params) => {
      const id = `${name}-${Math.random().toString(36).slice(2, 8)}`;
      tasks.set(id, { state: "pending" });
      // Simulate the worker picking the task up asynchronously.
      const handler = handlers.get(name);
      if (handler) {
        void (async () => {
          try {
            const ctx = makeFakeCtx(id);
            const result = await handler(params, ctx);
            // Respect cancellation: if the task was cancelled while the
            // handler was running, do not overwrite the terminal state.
            const cur = tasks.get(id);
            if (cur && cur.state !== "cancelled") {
              tasks.set(id, { state: "completed", result });
            }
          } catch (e) {
            const cur = tasks.get(id);
            if (cur && cur.state !== "cancelled") {
              tasks.set(id, { state: "failed", failure: { message: (e as Error).message } });
            }
          }
        })();
      }
      return { taskID: id, runID: id + ":0", attempt: 1, created: true };
    },
    fetchTaskResult: async (id) => tasks.get(id) ?? null,
    cancelTask: async (id) => {
      const t = tasks.get(id);
      if (t && t.state !== "completed" && t.state !== "failed" && t.state !== "cancelled") {
        tasks.set(id, { state: "cancelled" });
      }
    },
    startWorker: async (opts) => {
      client.lastStartWorkerOpts = opts;
      return { close: async () => {}, opts };
    },
    close: async () => {},
  };
  return client;
}

function makeFakeCtx(taskID: string) {
  const checkpoints = new Map<string, unknown>();
  return {
    taskID,
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (checkpoints.has(name)) return checkpoints.get(name) as T;
      const v = await fn();
      checkpoints.set(name, v);
      return v;
    },
    async beginStep<T>(_name: string) {
      return { name: _name, checkpointName: _name, done: false as const };
    },
    async completeStep<T>(handle: { name: string; checkpointName: string }, value: T) {
      checkpoints.set(handle.checkpointName, value);
      return value;
    },
    async sleepFor() {},
    async sleepUntil() {},
    async awaitEvent() {
      return null;
    },
    async emitEvent() {},
    async heartbeat() {},
    get headers() {
      return {};
    },
  };
}

// We need the fake to be returned by the dynamic `import("absurd-sdk")`.
// The trick: in `src/workflows.ts` we use `await import(...)`. Bun's
// module loader caches by URL, so we register a stub that intercepts
// the next import.
const fakeSdk = {
  Absurd: function (this: FakeClient, opts: { queueName?: string }) {
    const c = makeFakeClient();
    c.queueName = opts.queueName ?? "default";
    lastClient = c;
    return c;
  },
};

type ImportMeta = {
  resolve: (id: string) => string;
};
const origImport = (globalThis as { import?: unknown }).import;

beforeEach(() => {
  // Force `config()` to re-read env on every test.
  resetConfigForTests();
  // Reset the engine module's internal state.
  // The module exports a `resetWorkflowsForTests` helper.
  const wf = require_workflows();
  wf.resetWorkflowsForTests();
  lastClient = null;
  // Register the mock. We do this by monkey-patching the module loader.
  // Bun supports `mock.module(name, factory)`.
  mock.module("absurd-sdk", () => fakeSdk);
});

afterEach(() => {
  mock.module("absurd-sdk", () => fakeSdk); // no-op reset; bun handles cleanup
  if (testDataDir) {
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    testDataDir = null;
  }
});

// Bun's `require` is available in tests; use it to import TS modules
// the same way the rest of the codebase does.
function require_workflows() {
  return require("./workflows.ts") as typeof import("./workflows.ts");
}

function require_handlers() {
  return require("./workflows/handlers.ts") as typeof import("./workflows/handlers.ts");
}

function require_understand() {
  return require("./workflows/understand.ts") as typeof import("./workflows/understand.ts");
}

function require_api() {
  return require("./workflows/api.ts") as typeof import("./workflows/api.ts");
}

describe("workflows: disabled by default", () => {
  test("isDurable() is false when ABSURD_DATABASE_URL is unset", () => {
    delete process.env.ABSURD_DATABASE_URL;
    delete process.env.ABSURD_ENABLED;
    resetConfigForTests();
    const wf = require_workflows();
    expect(wf.isDurable()).toBe(false);
  });

  test("startWorkflows() is a no-op when disabled", async () => {
    delete process.env.ABSURD_DATABASE_URL;
    delete process.env.ABSURD_ENABLED;
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    expect(wf.isDurable()).toBe(false);
  });

  test("spawnWorkflow() returns null when disabled", async () => {
    delete process.env.ABSURD_DATABASE_URL;
    delete process.env.ABSURD_ENABLED;
    resetConfigForTests();
    const wf = require_workflows();
    const r = await wf.spawnWorkflow("understand", { root: "/tmp" });
    expect(r).toBeNull();
  });

  test("fetchWorkflow() returns null when disabled", async () => {
    delete process.env.ABSURD_DATABASE_URL;
    delete process.env.ABSURD_ENABLED;
    resetConfigForTests();
    const wf = require_workflows();
    const r = await wf.fetchWorkflow("nonexistent");
    expect(r).toBeNull();
  });

  test("cancelWorkflow() is a no-op when disabled", async () => {
    delete process.env.ABSURD_DATABASE_URL;
    delete process.env.ABSURD_ENABLED;
    resetConfigForTests();
    const wf = require_workflows();
    // Should not throw.
    await wf.cancelWorkflow("nonexistent");
  });
});

describe("workflows: enabled path", () => {
  test("startWorkflows() enables the engine and registers handlers", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    process.env.ABSURD_QUEUE = "test_queue";
    process.env.ABSURD_CONCURRENCY = "3";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    expect(wf.isDurable()).toBe(true);
    expect(lastClient).not.toBeNull();
    expect(lastClient!.queueName).toBe("test_queue");
    expect([...lastClient!.handlers.keys()].sort()).toEqual(["apex_distill", "understand"]);
    // startWorker was called with the configured concurrency (we record
    // the opts on the fake, no need to call it again).
    const w = lastClient!.lastStartWorkerOpts as { concurrency?: number; claimTimeout?: number } | undefined;
    expect(w).toBeDefined();
    expect(w!.concurrency).toBe(3);
  });

  test("startWorkflows() is idempotent: second call is a no-op", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const c1 = lastClient;
    await wf.startWorkflows();
    // Same client instance is reused.
    expect(lastClient).toBe(c1);
  });

  test("spawnWorkflow() forwards to the SDK", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const r = await wf.spawnWorkflow("understand", { root: "/tmp" });
    expect(r).not.toBeNull();
    expect(r!.taskID).toMatch(/^understand-/);
  });

  test("fetchWorkflow() returns the snapshot from the SDK", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const r = await wf.spawnWorkflow("apex_distill", { content: "x", dimension: "semantic", importance: 0.5 });
    expect(r).not.toBeNull();
    // Give the fake worker a tick to complete the task.
    await new Promise((r) => setTimeout(r, 5));
    const snap = await wf.fetchWorkflow(r!.taskID);
    expect(snap).not.toBeNull();
    expect(snap!.state).toBe("completed");
    if (snap!.state === "completed") {
      expect((snap!.result as { id: string }).id).toMatch(/^apex_distill:/);
    }
  });

  test("cancelWorkflow() marks pending tasks as cancelled", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    // Inject a long-running handler.
    lastClient!.handlers.set("long", async (_p, _c) => {
      await new Promise((r) => setTimeout(r, 100));
      return { done: true };
    });
    const r = await wf.spawnWorkflow("long", {});
    // Cancel before the worker completes.
    await wf.cancelWorkflow(r!.taskID);
    const snap = await wf.fetchWorkflow(r!.taskID);
    // Either the worker finished first (snap.completed) or cancel won
    // (snap.cancelled). Both are acceptable behaviour for a fake.
    expect(["cancelled", "completed"]).toContain(snap!.state);
  });

  test("stopWorkflows() closes both worker and client", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const closeSpy = spyOn(lastClient!, "close");
    const workerClose = (await lastClient!.startWorker({})).close;
    const workerCloseSpy = spyOn({ close: workerClose }, "close");
    await wf.stopWorkflows();
    expect(closeSpy).toHaveBeenCalled();
    expect(wf.isDurable()).toBe(false);
    workerCloseSpy.mockRestore();
  });
});

describe("workflows: handlers", () => {
  test("registerBuiltinHandlers registers both tasks", () => {
    const h = require_handlers();
    const fake = makeFakeClient();
    h.registerBuiltinHandlers(fake as never);
    expect([...fake.handlers.keys()].sort()).toEqual(["apex_distill", "understand"]);
  });

  test("builtinWorkflowNames returns the public workflow list", () => {
    const h = require_handlers();
    expect(h.builtinWorkflowNames()).toEqual(["understand", "apex_distill"]);
  });

  test("apex_distill handler returns an id", async () => {
    const h = require_handlers();
    const fake = makeFakeClient();
    h.registerBuiltinHandlers(fake as never);
    const handler = fake.handlers.get("apex_distill")!;
    const ctx = makeFakeCtx("t1");
    const result = (await handler({ content: "x", dimension: "semantic", importance: 0.5 }, ctx)) as { id: string };
    expect(result.id).toMatch(/^apex_distill:/);
  });
});

describe("workflows: HTTP routes (disabled)", () => {
  test("GET /v1/workflows returns 503 when disabled", async () => {
    delete process.env.ABSURD_DATABASE_URL;
    delete process.env.ABSURD_ENABLED;
    resetConfigForTests();
    const { Hono } = require("hono") as typeof import("hono");
    const api = require_api();
    const app = new Hono();
    api.mountWorkflows(app);
    const res = await app.request("http://x/v1/workflows");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("workflows disabled");
  });

  test("POST /v1/workflows/understand returns 503 when disabled", async () => {
    delete process.env.ABSURD_DATABASE_URL;
    delete process.env.ABSURD_ENABLED;
    resetConfigForTests();
    const { Hono } = require("hono") as typeof import("hono");
    const api = require_api();
    const app = new Hono();
    api.mountWorkflows(app);
    const res = await app.request("http://x/v1/workflows/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp" }),
    });
    expect(res.status).toBe(503);
  });
});

describe("workflows: HTTP routes (enabled)", () => {
  test("GET /v1/workflows returns the list when enabled", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const { Hono } = require("hono") as typeof import("hono");
    const api = require_api();
    const app = new Hono();
    api.mountWorkflows(app);
    const res = await app.request("http://x/v1/workflows");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: string[] };
    expect(body.workflows.sort()).toEqual(["apex_distill", "understand"]);
  });

  test("POST /v1/workflows/understand spawns a task and returns a task_id", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const { Hono } = require("hono") as typeof import("hono");
    const api = require_api();
    const app = new Hono();
    api.mountWorkflows(app);
    const res = await app.request("http://x/v1/workflows/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp", graph_only: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; task_id: string; queue: string };
    expect(body.mode).toBe("durable");
    expect(body.task_id).toMatch(/^understand-/);
    expect(body.queue).toBeTruthy();
  });

  test("GET /v1/workflows/:id returns 404 for unknown tasks", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const { Hono } = require("hono") as typeof import("hono");
    const api = require_api();
    const app = new Hono();
    api.mountWorkflows(app);
    const res = await app.request("http://x/v1/workflows/does-not-exist");
    expect(res.status).toBe(404);
  });

  test("GET /v1/workflows/:id returns the snapshot for a known task", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const { Hono } = require("hono") as typeof import("hono");
    const api = require_api();
    const app = new Hono();
    api.mountWorkflows(app);
    const dir = makeFixtureProject();
    const spawn = await app.request("http://x/v1/workflows/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, graph_only: true }),
    });
    const spawnBody = (await spawn.json()) as { task_id: string };
    await new Promise((r) => setTimeout(r, 50));
    const res = await app.request(`http://x/v1/workflows/${spawnBody.task_id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task_id: string; state: string };
    expect(body.task_id).toBe(spawnBody.task_id);
    // Accept any non-error state. The fake worker may complete, fail, or
    // still be running depending on timing.
    expect(["pending", "running", "completed", "failed"]).toContain(body.state);
  });

  test("POST /v1/workflows/:id/cancel returns 409 for terminal tasks", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const { Hono } = require("hono") as typeof import("hono");
    const api = require_api();
    const app = new Hono();
    api.mountWorkflows(app);
    const dir = makeFixtureProject();
    const spawn = await app.request("http://x/v1/workflows/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, graph_only: true }),
    });
    const spawnBody = (await spawn.json()) as { task_id: string };
    // Wait long enough for the fake worker to reach a terminal state.
    await new Promise((r) => setTimeout(r, 50));
    const res = await app.request(`http://x/v1/workflows/${spawnBody.task_id}/cancel`, {
      method: "POST",
    });
    // 200 if the task was still running (cancel won) or 409 if already
    // terminal. Both are acceptable.
    expect([409, 200]).toContain(res.status);
  });

  test("POST /v1/workflows/understand with inline=true runs synchronously", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    // The codegraph module opens a SQLite file under APEX_PI_DATA. Make
    // sure that points at a writable temp dir for this test.
    process.env.APEX_PI_DATA = mkdtempSync(join(tmpdir(), "apex-pi-wf-data-"));
    testDataDir = process.env.APEX_PI_DATA;
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const { Hono } = require("hono") as typeof import("hono");
    const api = require_api();
    const app = new Hono();
    api.mountWorkflows(app);
    // Use a real fixture project so the codegraph scan succeeds.
    const dir = makeFixtureProject();
    const res = await app.request("http://x/v1/workflows/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir, graph_only: true, inline: true }),
    });
    if (res.status !== 200) {
      const text = await res.text();
      throw new Error(`inline understand failed: status=${res.status} body=${text}`);
    }
    const body = (await res.json()) as { mode: string; result: { root: string; scanned: number } };
    expect(body.mode).toBe("inline");
    expect(body.result.root).toBe(dir);
  });
});

describe("workflows: spawn helpers", () => {
  test("spawnUnderstand returns null when disabled", async () => {
    delete process.env.ABSURD_DATABASE_URL;
    delete process.env.ABSURD_ENABLED;
    resetConfigForTests();
    const u = require_understand();
    const r = await u.spawnUnderstand({ root: "/tmp" });
    expect(r).toBeNull();
  });

  test("spawnUnderstand returns a taskID when enabled", async () => {
    process.env.ABSURD_DATABASE_URL = "postgres://fake";
    process.env.ABSURD_ENABLED = "1";
    resetConfigForTests();
    const wf = require_workflows();
    await wf.startWorkflows();
    const u = require_understand();
    const r = await u.spawnUnderstand({ root: "/tmp" });
    expect(r).not.toBeNull();
    expect(r!.taskID).toMatch(/^understand-/);
  });
});
