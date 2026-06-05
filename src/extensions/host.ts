// src/extensions/host.ts
//
// Minimal in-process implementation of the pi-coding-agent `ExtensionAPI`
// surface, so our extensions can be loaded both:
//
//   (a) into a real `pi` runtime (pi-coding-agent will pass the real
//       ExtensionAPI — our extension factory function accepts it),
//   (b) into a long-running apex-pi server / CLI / MCP host, where we
//       own the Agent instance directly.
//
// We intentionally implement a *subset* — enough for `registerTool`,
// `on(event, handler)`, and `emit(event, payload)`. Extensions written
// against this shim can be lifted into pi-coding-agent unchanged.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export interface ApexExtensionContext {
  /** Read-only access to the running ctx. */
  cwd: string;
  hasUI: boolean;
  notify(msg: string, level?: "info" | "warn" | "error"): void;
}

export interface ApexExtensionAPI {
  /** Register a tool. The runtime wires the returned tool to Agent. */
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(
    tool: AgentTool<TParams, TDetails>,
  ): void;

  /** Subscribe to a runtime event. Returns an unsubscribe fn. */
  on(event: string, handler: (payload: unknown) => unknown | Promise<unknown>): () => void;

  /** Fire an event to all subscribers. */
  emit(event: string, payload: unknown): Promise<void>;

  /** Read-only access to shared context. */
  ctx(): ApexExtensionContext;

  /** All registered tools, in registration order. */
  tools(): AgentTool<any, any>[];
}

export function createExtensionHost(initial?: Partial<ApexExtensionContext>): ApexExtensionAPI {
  const tools: AgentTool<any, any>[] = [];
  const listeners = new Map<string, Set<(p: unknown) => unknown | Promise<unknown>>>();
  const ctx: ApexExtensionContext = {
    cwd: initial?.cwd ?? process.cwd(),
    hasUI: initial?.hasUI ?? false,
    notify(msg, level = "info") {
      // The HTTP / MCP host subscribes via `on("notify", ...)` to forward
      // these to a websocket or SSE stream. Until then, log to stdout.
      const tag = level === "error" ? "error" : level === "warn" ? "warn" : "info";
      console[tag === "error" ? "error" : tag === "warn" ? "warn" : "log"](`[notify] ${msg}`);
    },
  };

  return {
    registerTool(tool) {
      // Idempotent: re-registering an existing name replaces it.
      const idx = tools.findIndex((t) => t.name === tool.name);
      if (idx >= 0) tools[idx] = tool;
      else tools.push(tool);
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => {
        listeners.get(event)?.delete(handler);
      };
    },
    async emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try {
          await fn(payload);
        } catch (e) {
          // Listener errors must not crash the host.
          console.error(`[extension-host] listener for "${event}" threw:`, (e as Error).message);
        }
      }
    },
    ctx: () => ctx,
    tools: () => tools.slice(),
  };
}
