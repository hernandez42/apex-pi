// src/extensions/host.test.ts — verifies the minimal ExtensionAPI shim
// behaves like pi-coding-agent's surface (registerTool, on/emit).

import { test, expect } from "bun:test";
import { Type } from "typebox";
import { createExtensionHost } from "./host.ts";

test("registerTool accumulates and de-duplicates by name", () => {
  const h = createExtensionHost();
  h.registerTool({
    name: "x",
    label: "X",
    description: "x",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  });
  h.registerTool({
    name: "x",
    label: "X2",
    description: "x2",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  });
  expect(h.tools()).toHaveLength(1);
  expect(h.tools()[0]!.label).toBe("X2");
});

test("on/emit delivers events in registration order", async () => {
  const h = createExtensionHost();
  const got: number[] = [];
  h.on("ping", (p) => { got.push((p as { n: number }).n); return undefined; });
  await h.emit("ping", { n: 1 });
  await h.emit("ping", { n: 2 });
  expect(got).toEqual([1, 2]);
});

test("listener errors do not crash the host", async () => {
  const h = createExtensionHost();
  let called = false;
  h.on("boom", () => { throw new Error("nope"); });
  h.on("boom", () => { called = true; return undefined; });
  await h.emit("boom", null);
  expect(called).toBe(true);
});

test("unsubscribe detaches the handler", async () => {
  const h = createExtensionHost();
  let count = 0;
  const off = h.on("e", () => { count++; });
  await h.emit("e", null);
  off();
  await h.emit("e", null);
  expect(count).toBe(1);
});
