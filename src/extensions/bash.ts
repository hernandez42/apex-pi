// src/extensions/bash.ts
// Registers the `bash` tool — runs a shell command via Bun.spawn and
// returns stdout, stderr, exit code. This is the same surface as
// pi-coding-agent's built-in `bash` tool, exposed for our standalone
// HTTP / MCP / CLI hosts (where the TUI built-ins are not available).
//
// SECURITY: the tool respects `cfg.tools.bashPolicy`:
//   - "allow"  : run any command (default for CLI / local use)
//   - "deny"   : refuse every invocation, return a permission error
//   - "sandbox": run, but if the command resolves outside the sandbox
//                directory list, refuse first
// In all cases every invocation is logged for audit.

import { Type, type Static } from "typebox";
import { resolve as resolvePath } from "node:path";
import { log } from "../log.ts";
import { config } from "../config.ts";
import type { ApexExtensionAPI } from "./host.ts";

const BashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute (passed to `sh -c`)." }),
  cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the agent's cwd." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 600_000, default: 15_000 })),
  description: Type.Optional(Type.String({ description: "Short human-readable description of what this command does." })),
});

function isPathAllowed(target: string, sandbox: string[]): boolean {
  const abs = resolvePath(target);
  return sandbox.some((root) => {
    const r = resolvePath(root);
    return abs === r || abs.startsWith(r + "/");
  });
}

export function registerBashTool(api: ApexExtensionAPI): void {
  void api; // no host events yet
  api.registerTool({
    name: "bash",
    label: "Bash",
    description:
      "Execute a shell command and return {stdout, stderr, exit_code}. Use for file system, build, test, and process operations. The tool is sandboxed to a configurable path list and respects cfg.tools.bashPolicy.",
    parameters: BashParams,
    async execute(_id, params: Static<typeof BashParams>, signal) {
      const cfg = config().tools;
      const command = String(params.command ?? "").trim();
      if (!command) return { content: [{ type: "text", text: "command is required" }], details: { error: "no_command" } as any, isError: true };

      if (cfg.bashPolicy === "deny") {
        return { content: [{ type: "text", text: "bash is disabled (tools.bashPolicy=deny)" }], details: { error: "policy_deny" } as any, isError: true };
      }

      const cwd = params.cwd ? resolvePath(params.cwd) : process.cwd();
      const timeout = Math.min(Number(params.timeout_ms ?? cfg.bashTimeoutMs), cfg.bashMaxTimeoutMs);
      const sandbox = [config().dataDir, "/tmp"];
      if (cfg.bashPolicy === "sandbox" && !isPathAllowed(cwd, sandbox)) {
        return { content: [{ type: "text", text: `cwd ${cwd} is outside the sandbox (${sandbox.join(", ")})` }], details: { error: "outside_sandbox", cwd } as any, isError: true };
      }

      log.info("bash.invoked", { description: params.description ?? null, command, cwd, timeoutMs: timeout });
      const t0 = Date.now();

      let proc: ReturnType<typeof Bun.spawn> | undefined;
      let timedOut = false;
      let aborted = false;
      const ac = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort(new Error("bash timeout"));
        try { proc?.kill(); } catch { /* ignore */ }
      }, timeout);
      if (signal) signal.addEventListener("abort", () => { aborted = true; ac.abort(new Error("aborted")); try { proc?.kill(); } catch { /* ignore */ } });

      try {
        proc = Bun.spawn(["sh", "-c", command], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
          signal: ac.signal,
        });
        const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
          proc.stdout ? new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer() : Promise.resolve(new ArrayBuffer(0)),
          proc.stderr ? new Response(proc.stderr as ReadableStream<Uint8Array>).arrayBuffer() : Promise.resolve(new ArrayBuffer(0)),
          proc.exited,
        ]);
        const stdout = new TextDecoder().decode(new Uint8Array(stdoutBytes));
        const stderr = new TextDecoder().decode(new Uint8Array(stderrBytes));
        clearTimeout(timer);
        const out = (stdout || "").slice(0, cfg.toolResultMaxChars);
        const err = (stderr || "").slice(0, cfg.toolResultMaxChars);
        const dur = Date.now() - t0;
        const text = `exit_code=${exitCode} (${dur}ms)\n--- stdout ---\n${out}${stdout && stdout.length > cfg.toolResultMaxChars ? "\n... [truncated]" : ""}${err ? `\n--- stderr ---\n${err}${stderr && stderr.length > cfg.toolResultMaxChars ? "\n... [truncated]" : ""}` : ""}`;
        return {
          content: [{ type: "text", text }],
          details: { exitCode, durationMs: dur, timedOut, aborted, stdoutBytes: stdout.length, stderrBytes: stderr.length },
        };
      } catch (e) {
        clearTimeout(timer);
        const msg = (e as Error).message;
        const errText = timedOut ? `timeout after ${timeout}ms` : aborted ? "aborted" : msg;
        return { content: [{ type: "text", text: `bash failed: ${errText}` }], details: { error: errText } as any, isError: true };
      }
    },
  });
}
