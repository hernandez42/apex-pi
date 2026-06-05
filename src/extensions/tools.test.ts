// src/extensions/tools.test.ts — verifies bash/read/write/edit sandboxes
// and behaviour against a real on-disk directory.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionHost } from "./host.ts";
import { installApexExtensions } from "./index.ts";
import { resetConfigForTests } from "../config.ts";

let sandbox: string;
let host: ReturnType<typeof createExtensionHost>;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "apex-pi-tools-"));
  process.env.APEX_PI_DATA = sandbox;
  process.env.TOOL_BASH_POLICY = "sandbox";
  process.env.TOOL_SANDBOX_PATHS = "";
  resetConfigForTests();
  host = createExtensionHost();
  installApexExtensions(host);
});

afterAll(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

function getTool(name: string) {
  const t = host.tools().find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t as unknown as {
    execute(id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown): Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }>;
  };
}

test("core tools (bash, read, write, edit) are registered", () => {
  const names = host.tools().map((t) => t.name);
  expect(names).toContain("bash");
  expect(names).toContain("read");
  expect(names).toContain("write");
  expect(names).toContain("edit");
});

test("write + read round-trips a file inside the sandbox", async () => {
  const file = join(sandbox, "hello.txt");
  const w = await getTool("write").execute("t1", { path: file, content: "alpha\nbeta\ngamma" });
  expect((w.details as { bytes: number }).bytes).toBe("alpha\nbeta\ngamma".length);
  const r = await getTool("read").execute("t2", { path: file });
  expect((r.details as { bytes: number }).bytes).toBe("alpha\nbeta\ngamma".length);
  expect(r.content[0]!.text).toContain("beta");
});

test("read with from_line + limit slices the file", async () => {
  const file = join(sandbox, "lines.txt");
  writeFileSync(file, "L1\nL2\nL3\nL4\nL5", "utf8");
  const r = await getTool("read").execute("t", { path: file, from_line: 1, limit: 2 });
  const text = r.content[0]!.text;
  expect(text).toContain("L2");
  expect(text).toContain("L3");
  expect(text).not.toContain("L5");
});

test("edit finds, replaces, and refuses ambiguous matches", async () => {
  const file = join(sandbox, "edit.txt");
  writeFileSync(file, "foo bar foo", "utf8");
  // ambiguous (2 matches), no replace_all
  const ambig = await getTool("edit").execute("t1", { path: file, old_text: "foo", new_text: "baz" });
  expect(ambig.isError).toBe(true);
  // explicit unique match
  writeFileSync(file, "foo bar", "utf8");
  const ok = await getTool("edit").execute("t2", { path: file, old_text: "foo bar", new_text: "hello world" });
  expect(ok.isError).toBeFalsy();
  expect(readFileSync(file, "utf8")).toBe("hello world");
  // replace_all
  writeFileSync(file, "foo bar foo", "utf8");
  const all = await getTool("edit").execute("t3", { path: file, old_text: "foo", new_text: "baz", replace_all: true });
  expect(all.isError).toBeFalsy();
  expect(readFileSync(file, "utf8")).toBe("baz bar baz");
});

test("write/edit refuse paths outside the sandbox", async () => {
  const outside = "/etc/hostname-should-not-be-overwritten";
  const w = await getTool("write").execute("t1", { path: outside, content: "x" });
  expect(w.isError).toBe(true);
  const e = await getTool("edit").execute("t2", { path: outside, old_text: "a", new_text: "b" });
  expect(e.isError).toBe(true);
});

test("bash runs a simple command and captures stdout/exit", async () => {
  const r = await getTool("bash").execute("t", { command: "echo hello-from-bash", cwd: sandbox });
  const text = r.content[0]!.text;
  expect(text).toContain("hello-from-bash");
  expect((r.details as { exitCode: number }).exitCode).toBe(0);
});

test("bash returns non-zero exit code for failing commands", async () => {
  const r = await getTool("bash").execute("t", { command: "exit 7", cwd: sandbox });
  expect((r.details as { exitCode: number }).exitCode).toBe(7);
});

test("bash policy=deny refuses every invocation", async () => {
  process.env.TOOL_BASH_POLICY = "deny";
  resetConfigForTests();
  const h2 = createExtensionHost();
  installApexExtensions(h2);
  const t = h2.tools().find((x) => x.name === "bash")! as unknown as { execute(id: string, params: unknown): Promise<{ isError?: boolean }> };
  const r = await t.execute("t", { command: "echo hi" });
  expect(r.isError).toBe(true);
  process.env.TOOL_BASH_POLICY = "sandbox";
  resetConfigForTests();
});
