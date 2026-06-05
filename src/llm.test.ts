// src/llm.test.ts — verifies the shared model resolver used by both the
// agent and the /understand pipeline. Bug #2 regression test: ensure
// `openai-compatible` and other friendly aliases map to a real provider
// with a non-null `api` field, and that unknown providers fall back to
// `openai/gpt-4o-mini` instead of returning `undefined`.

import { test, expect, beforeEach, afterEach } from "bun:test";

const ORIGINAL = {
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  LLM_MODEL: process.env.LLM_MODEL,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
};

beforeEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
});

afterEach(() => {
  if (ORIGINAL.LLM_PROVIDER === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = ORIGINAL.LLM_PROVIDER;
  if (ORIGINAL.LLM_MODEL === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = ORIGINAL.LLM_MODEL;
  if (ORIGINAL.LLM_BASE_URL === undefined) delete process.env.LLM_BASE_URL;
  else process.env.LLM_BASE_URL = ORIGINAL.LLM_BASE_URL;
});

test("resolveModel default returns an OpenAI model with a valid `api`", async () => {
  const { resolveModel } = await import("./llm.ts");
  const m = resolveModel();
  expect(m).toBeDefined();
  expect(m.api).toBeTruthy();
  expect(typeof m.api).toBe("string");
  expect(m.id).toBe("gpt-4o-mini");
});

test("resolveModel honours LLM_MODEL override", async () => {
  process.env.LLM_MODEL = "gpt-4o";
  const { resolveModel } = await import("./llm.ts");
  const m = resolveModel();
  expect(m.id).toBe("gpt-4o");
  expect(m.api).toBeTruthy();
});

test("resolveModel maps `openai-compatible` alias to a real model (Bug #2)", async () => {
  process.env.LLM_PROVIDER = "openai-compatible";
  process.env.LLM_MODEL = "LongCat-2.0-Preview";
  // Without LLM_BASE_URL the call would have returned undefined and
  // crashed complete() with "evaluating 'model.api'". We set a URL so
  // the resolver returns a usable OpenAI-shape model.
  process.env.LLM_BASE_URL = "https://api.longcat.chat/v1";
  const { resolveModel } = await import("./llm.ts");
  const m = resolveModel();
  expect(m).toBeDefined();
  expect(m.api).toBeTruthy();
  expect((m as { baseUrl?: string }).baseUrl).toBe("https://api.longcat.chat/v1");
});

test("resolveModel maps other friendly aliases (openai_compatible, oai)", async () => {
  for (const alias of ["openai_compatible", "oai", "openai-completions"]) {
    process.env.LLM_PROVIDER = alias;
    const { resolveModel } = await import("./llm.ts?" + alias);
    const m = resolveModel();
    expect(m).toBeDefined();
    expect(m.api).toBeTruthy();
  }
});

test("resolveModel falls back to openai/gpt-4o-mini on unknown provider", async () => {
  process.env.LLM_PROVIDER = "definitely-not-a-real-provider";
  const { resolveModel } = await import("./llm.ts");
  const m = resolveModel();
  expect(m).toBeDefined();
  expect(m.api).toBeTruthy();
  expect(m.id).toBe("gpt-4o-mini");
});

test("resolveModel applies LLM_BASE_URL to the resolved model", async () => {
  process.env.LLM_BASE_URL = "https://my-proxy.example.com/v1/";
  const { resolveModel } = await import("./llm.ts");
  const m = resolveModel();
  expect((m as { baseUrl?: string }).baseUrl).toBe("https://my-proxy.example.com/v1");
});

test("knownProviderAliases lists the friendly names", async () => {
  const { knownProviderAliases } = await import("./llm.ts");
  const a = knownProviderAliases();
  expect(a["openai-compatible"]).toBe("openai");
  expect(a["oai"]).toBe("openai");
});
