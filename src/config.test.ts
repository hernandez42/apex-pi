// src/config.test.ts — covers the env-var reload behaviour (Bug #7).

import { test, expect, afterEach } from "bun:test";
import { config, reloadConfig, resetConfigForTests } from "./config.ts";

afterEach(() => {
  resetConfigForTests();
});

test("config() returns the same instance on repeated calls (cache)", () => {
  const a = config();
  const b = config();
  expect(a).toBe(b);
});

test("reloadConfig() re-reads env vars at runtime — Bug #7", () => {
  process.env.PORT = "1111";
  resetConfigForTests();
  expect(config().http.port).toBe(1111);

  // Mutate env AFTER first config() call — cache should be stale.
  process.env.PORT = "2222";
  expect(config().http.port).toBe(1111);

  reloadConfig();
  expect(config().http.port).toBe(2222);

  delete process.env.PORT;
  reloadConfig();
  expect(config().http.port).toBe(8080); // default
});

test("resetConfigForTests is an alias for reloadConfig", () => {
  process.env.PORT = "3333";
  resetConfigForTests();
  expect(config().http.port).toBe(3333);

  process.env.PORT = "4444";
  resetConfigForTests();
  expect(config().http.port).toBe(4444);

  delete process.env.PORT;
  resetConfigForTests();
});
