// src/extensions/fs.ts
// Registers the three file-system tools used by pi-coding-agent TUI:
//   - read   : read a file, optionally a line range
//   - write  : create / overwrite a file (atomic via temp + rename)
//   - edit   : find / replace in a file (refuses ambiguous matches)
//
// All three are sandboxed to APEX_PI_DATA plus an explicit allowlist, so
// the agent cannot read or write outside the persistent volume by
// accident. The sandbox list is configurable via cfg.tools.sandboxPaths.

import { Type, type Static } from "typebox";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "../log.ts";
import { config } from "../config.ts";
import type { ApexExtensionAPI } from "./host.ts";

const ReadParams = Type.Object({
  path: Type.String({ description: "Absolute or agent-cwd-relative path." }),
  from_line: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5_000, default: 200 })),
});
const WriteParams = Type.Object({
  path: Type.String({ description: "Absolute or agent-cwd-relative path." }),
  content: Type.String({ description: "Full file contents to write." }),
});
const EditParams = Type.Object({
  path: Type.String({ description: "Absolute or agent-cwd-relative path." }),
  old_text: Type.String({ description: "Exact text to find (must be unique unless replace_all=true)." }),
  new_text: Type.String({ description: "Replacement text." }),
  replace_all: Type.Optional(Type.Boolean({ default: false })),
});

function resolveSafePath(p: string, sandbox: string[]): string | { error: string } {
  const abs = isAbsolute(p) ? p : resolvePath(process.cwd(), p);
  const ok = sandbox.some((root) => {
    const r = resolvePath(root);
    return abs === r || abs.startsWith(r + "/");
  });
  if (!ok) return { error: `path ${abs} is outside the sandbox (${sandbox.join(", ")})` };
  return abs;
}

function sandboxRoots(): string[] {
  const cfg = config();
  return Array.from(new Set([cfg.dataDir, ...(cfg.tools.sandboxPaths ?? [])]));
}

export function registerFsTools(api: ApexExtensionAPI): void {
  void api;

  // ───── read ───────────────────────────────────────────────────────────
  api.registerTool({
    name: "read",
    label: "Read",
    description:
      "Read a file from disk. Returns the contents with 1-based line numbers, optionally starting at from_line and capped at limit lines. Use this instead of `cat` in the shell.",
    parameters: ReadParams,
    async execute(_id, params: Static<typeof ReadParams>) {
      const cfg = config().tools;
      const resolved = resolveSafePath(String(params.path ?? ""), sandboxRoots());
      if (typeof resolved === "object") return { content: [{ type: "text", text: resolved.error }], details: { error: "outside_sandbox" } as any, isError: true };
      if (!existsSync(resolved)) return { content: [{ type: "text", text: `file not found: ${resolved}` }], details: { error: "not_found" } as any, isError: true };
      const st = statSync(resolved);
      if (!st.isFile()) return { content: [{ type: "text", text: `not a regular file: ${resolved}` }], details: { error: "not_file" } as any, isError: true };
      if (st.size > cfg.readHardLimitBytes) return { content: [{ type: "text", text: `file too large (${st.size}B > hard limit ${cfg.readHardLimitBytes}B)` }], details: { error: "too_large", size: st.size } as any, isError: true };

      const all = readFileSync(resolved, "utf8");
      const lines = all.split(/\r?\n/);
      const from = Math.max(0, Number(params.from_line ?? 0));
      const limit = Math.max(1, Math.min(Number(params.limit ?? 200), 5_000));
      const slice = lines.slice(from, from + limit);
      const truncated = all.length > cfg.readMaxBytes;
      const numbered = slice.map((l, i) => `${String(from + i + 1).padStart(5, " ")} | ${l}`).join("\n");
      const header = `${resolved} (${st.size} bytes, ${lines.length} lines)\n${"─".repeat(60)}\n`;
      return {
        content: [{ type: "text", text: header + numbered + (truncated ? `\n... [truncated at ${cfg.readMaxBytes}B]` : "") }],
        details: { path: resolved, bytes: st.size, lines: lines.length, from, limit, truncated },
      };
    },
  });

  // ───── write ──────────────────────────────────────────────────────────
  api.registerTool({
    name: "write",
    label: "Write",
    description:
      "Create or overwrite a file with the given content. Writes are atomic (temp + rename) and create parent directories as needed.",
    parameters: WriteParams,
    async execute(_id, params: Static<typeof WriteParams>) {
      const resolved = resolveSafePath(String(params.path ?? ""), sandboxRoots());
      if (typeof resolved === "object") return { content: [{ type: "text", text: resolved.error }], details: { error: "outside_sandbox" } as any, isError: true };
      const content = String(params.content ?? "");
      const dir = dirname(resolved);
      mkdirSync(dir, { recursive: true });
      const tmp = `${resolved}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        writeFileSync(tmp, content, "utf8");
        renameSync(tmp, resolved);
      } catch (e) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        return { content: [{ type: "text", text: `write failed: ${(e as Error).message}` }], details: { error: (e as Error).message } as any, isError: true };
      }
      log.info("fs.written", { path: resolved, bytes: content.length });
      return { content: [{ type: "text", text: `wrote ${content.length} bytes to ${resolved}` }], details: { path: resolved, bytes: content.length } };
    },
  });

  // ───── edit ───────────────────────────────────────────────────────────
  api.registerTool({
    name: "edit",
    label: "Edit",
    description:
      "Find and replace a unique text fragment in a file. By default refuses to operate if `old_text` is not found or matches more than once; pass replace_all=true to allow multiple replacements.",
    parameters: EditParams,
    async execute(_id, params: Static<typeof EditParams>) {
      const resolved = resolveSafePath(String(params.path ?? ""), sandboxRoots());
      if (typeof resolved === "object") return { content: [{ type: "text", text: resolved.error }], details: { error: "outside_sandbox" } as any, isError: true };
      if (!existsSync(resolved)) return { content: [{ type: "text", text: `file not found: ${resolved}` }], details: { error: "not_found" } as any, isError: true };
      const oldText = String(params.old_text ?? "");
      const newText = String(params.new_text ?? "");
      const replaceAll = params.replace_all === true;
      if (!oldText) return { content: [{ type: "text", text: "old_text is required" }], details: { error: "no_old_text" } as any, isError: true };
      const original = readFileSync(resolved, "utf8");
      const occurrences = original.split(oldText).length - 1;
      if (occurrences === 0) return { content: [{ type: "text", text: `old_text not found in ${resolved}` }], details: { error: "not_found", occurrences: 0 } as any, isError: true };
      if (occurrences > 1 && !replaceAll) return { content: [{ type: "text", text: `old_text matches ${occurrences} times in ${resolved}; pass replace_all=true to edit all of them` }], details: { error: "ambiguous", occurrences } as any, isError: true };
      const updated = replaceAll ? original.split(oldText).join(newText) : original.replace(oldText, newText);
      const tmp = `${resolved}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        writeFileSync(tmp, updated, "utf8");
        renameSync(tmp, resolved);
      } catch (e) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        return { content: [{ type: "text", text: `edit failed: ${(e as Error).message}` }], details: { error: (e as Error).message } as any, isError: true };
      }
      log.info("fs.edited", { path: resolved, occurrences, replaceAll });
      return { content: [{ type: "text", text: `edited ${resolved} (${occurrences} replacement${occurrences === 1 ? "" : "s"})` }], details: { path: resolved, occurrences, replaceAll } };
    },
  });
}
