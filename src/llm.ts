// src/llm.ts
//
// Shared model resolution. Both `agent.ts` (the chat agent) and
// `understand/pipeline.ts` (the LLM explainer) need a `Model<any>` from
// pi-ai's `getModel(provider, id)`. They used to call it independently:
//
//   * `agent.ts` did it correctly: try the configured provider, fall back
//     to `openai/gpt-4o-mini`, then override `baseUrl` from `LLM_BASE_URL`.
//   * `pipeline.ts` called `getModel` raw with no baseUrl override and no
//     fallback. When the user set `LLM_PROVIDER=openai-compatible` (a name
//     pi-ai does not recognise) `getModel` returned `undefined`, so the
//     subsequent `complete(model, …)` call crashed with
//     `undefined is not an object (evaluating 'model.api')`.
//
// This module is the single source of truth. It also maps a few friendly
// provider aliases so the user does not have to remember pi-ai's exact
// spelling.

import { getModel, type Model } from "@earendil-works/pi-ai";
import { log } from "./log.ts";

/** Friendly aliases → real pi-ai provider names. The user can write
 *  `LLM_PROVIDER=openai-compatible` and we map it to `openai` (which is
 *  the only OpenAI-protocol provider in pi-ai) and force `baseUrl` to
 *  the OpenAI-compatible URL they configured. */
const PROVIDER_ALIASES: Record<string, string> = {
  "openai-compatible": "openai",
  "openai_compatible": "openai",
  "openai-completions": "openai",
  "oai": "openai",
};

/** Resolve the model the user asked for. Order of operations:
 *  1. Map friendly aliases (`openai-compatible` → `openai`).
 *  2. Try `getModel(provider, model)`. On success, override `baseUrl`
 *     from `LLM_BASE_URL` so OpenAI-compatible endpoints (LongCat,
 *     OpenRouter, LiteLLM, vLLM, etc.) work out of the box.
 *  3. On any failure, fall back to `openai/gpt-4o-mini` and apply the
 *     same `baseUrl` override.
 *  4. If even the fallback fails, return the most permissive Model
 *     object the runtime can produce (still with `api: "openai-completions"`)
 *     so callers can decide how to degrade. */
export function resolveModel(): Model<any> {
  const rawProvider = (process.env.LLM_PROVIDER ?? "openai").trim();
  const provider = PROVIDER_ALIASES[rawProvider.toLowerCase()] ?? rawProvider;
  const id = (process.env.LLM_MODEL ?? "gpt-4o-mini").trim();
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, "");

  const apply = (m: Model<any>): Model<any> => {
    if (baseUrl && (m as { baseUrl?: string }).baseUrl !== baseUrl) {
      // pi-ai ships Model objects as frozen (Object.freeze), so we cannot
      // mutate `baseUrl` in place. Clone the object with the override
      // applied. A shallow copy is enough — callers read top-level fields
      // (id, name, api, baseUrl) and pass the model to `complete()`, which
      // does not rely on identity.
      const cloned = { ...m, baseUrl };
      log.info("model.baseUrl.override", { provider, model: id, baseUrl });
      return cloned as Model<any>;
    }
    return m;
  };

  try {
    return apply(getModel(provider as never, id as never));
  } catch (e) {
    log.warn("model.resolve.fail", { provider, model: id, err: (e as Error).message });
    try {
      return apply(getModel("openai" as never, "gpt-4o-mini" as never));
    } catch (e2) {
      log.error("model.resolve.fallback.fail", { err: (e2 as Error).message });
      // Hard last-resort: synthesise a Model object so the caller does
      // not get `undefined`. The next `complete()` will fail loudly if
      // the network is reachable, but the API surface stays consistent.
      return {
        id,
        name: id,
        api: "openai-completions",
        baseUrl: baseUrl ?? "https://api.openai.com/v1",
        provider,
        contextWindow: 8192,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        capabilities: ["text"],
        headers: () => ({}),
      } as unknown as Model<any>;
    }
  }
}

/** Test/utility: list the friendly provider aliases. */
export function knownProviderAliases(): Record<string, string> {
  return { ...PROVIDER_ALIASES };
}
