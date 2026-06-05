# apex-pi

**A pi-mono distribution** that adds three durable capabilities to the
[earendil-works/pi](https://github.com/earendil-works/pi) agent runtime:

| Source                                | What we keep                                                                                     | How we integrate                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `@earendil-works/pi-ai`               | 50+ LLM providers (OpenAI, Anthropic, Google, Bedrock, OpenRouter, Mistral, Groq, xAI, Ollama…) | direct dependency, `getModel(provider, model)`                                                          |
| `@earendil-works/pi-agent-core`       | `Agent` class with tool calling, parallel execution, steering, follow-up, event streaming         | direct dependency; our `agent.ts` is a thin singleton over it                                            |
| `badlogic/pi-mono` extension system   | TypeBox-typed tools, event hooks, prompt snippets, session state                                  | we ship a `pi` manifest so `pi install npm:apex-pi` loads our tools + skills                            |
| `hernandez42/APEX-MEM` (Rust)         | 5D memory dimensions, hybrid retrieval, dreaming, knowledge graph                                | in-process TS reimplementation, **wire-compatible** with the Rust `apex-mem` JSON-RPC schema           |
| `Lum1104/Understand-Anything`         | multi-phase codebase explanation                                                                  | scanner + codegraph + single LLM explainer call                                                        |
| `codegraph-ai/CodeGraph`              | symbol index, callers / callees, impact analysis                                                 | SQLite-backed regex indexer; reused by the `/understand` pipeline                                       |
| `affaan-m/ECC`                        | instincts (security, smallest-viable-diff, learn-from-feedback, self-distill)                     | always-on system prompt + `apex_feedback` / `apex_distill` tools                                        |
| `@larksuiteoapi/node-sdk`             | official Feishu / Lark event subscription (Socket Mode + webhook)                                | pi-mom-style channel (`channels/feishu.ts`); we don't reimplement the wire protocol                    |

> **Design north star:** do not duplicate what pi-mono already does. Our
> code is **only** the apex additions (apex-mem, codegraph, understand,
> Feishu, MCP) — everything else is a dependency.

---

## ✨ What you get

- `Agent` runtime inherited from `@earendil-works/pi-agent-core` (parallel
  tool calls, steering, follow-up, event subscription, tool retries via
  `beforeToolCall` / `afterToolCall`)
- 50+ LLM providers with auto-discovery, OAuth, cost tracking, thinking
  budgets — all from `pi-ai`
- **apex-mem** 5D memory: working / episodic / semantic / procedural /
  declarative with BM25 + lexical + graph BFS + RRF fusion, plus
  background dreaming (decay / dedup / promote)
- **codegraph**: regex-based symbol index for 20+ languages, callers,
  callees, blast-radius impact, FTS-free SQL queries
- **understand pipeline**: 5-phase scanner → analyzer → tours → hotspots
  → LLM explainer on a single directory
- **ECC instincts** in the system prompt + two learning tools
  (`apex_feedback` for natural-language feedback, `apex_distill` for
  skill synthesis)
- **MCP server** (Streamable HTTP, spec 2025-03-26) exposing the same
  tools so Claude Desktop / Cursor / Continue can consume apex-pi
- **FeishuMom** channel (pi-mom's pattern) using the official
  `@larksuiteoapi/node-sdk` with WebSocket + webhook
- Hono HTTP server with SSE streaming chat, on the same Agent
- **Pi Package** integration: `pi install npm:apex-pi` adds our tools
  and skills to a regular `pi` session

---

## 📦 Install

```bash
# As a standalone binary (Bun runtime, ~30 MB RAM idle)
git clone https://github.com/hernandez42/apex-pi
cd apex-pi
bun install
bun run build:compile     # produces dist/apex-pi (linux-x64, self-contained)
./dist/apex-pi             # starts the HTTP server on :8080

# As a pi-mono extension (uses your existing `pi` install)
pi install npm:apex-pi
pi --extension apex-pi    # tools + skills auto-discovered
```

---

## 🛠 Quick start

```bash
cp .env.example .env
# Set LLM_PROVIDER + LLM_MODEL + LLM_API_KEY (or any other pi-ai provider)
bun install
bun run check         # environment diagnostic
bun test              # 4 test files: memory, codegraph, extensions, http e2e
bun run dev           # HTTP server on :8080 → http://localhost:8080
# Dockerfile is included; deploy to any container host that supports linux-x64
```

CLI:

```bash
apex-pi "explain this project"          # one-shot agent turn
apex-pi --feishu                        # start the Feishu WebSocket bot
apex-pi --mcp                           # start a standalone MCP stdio server
apex-pi --understand ./src              # 5-phase understand pipeline
apex-pi --ingest semantic "Bun > Node"  # add a memory record
apex-pi --search "fast JS runtime"      # hybrid memory search
apex-pi --stats                         # memory + codegraph stats
```

HTTP API (subset):

| Method | Path                          | Purpose                                        |
| ------ | ----------------------------- | ---------------------------------------------- |
| GET    | `/healthz`                    | liveness                                       |
| GET    | `/readyz`                     | readiness + memory stats                       |
| POST   | `/v1/chat`                    | SSE stream of an agent turn                    |
| POST   | `/v1/memories`                | ingest a record                                |
| POST   | `/v1/memories/search`         | hybrid search                                  |
| POST   | `/v1/feedback`                | ingest user feedback (learn loop)              |
| GET    | `/v1/stats`                   | memory + codegraph counters                    |
| GET    | `/v1/graph`                   | Cytoscape-ready knowledge graph                |
| POST   | `/v1/understand`              | 5-phase pipeline over a directory              |
| POST   | `/v1/codegraph/index`         | (re)index a directory                          |
| GET    | `/v1/codegraph/search?q=`     | symbol search                                  |
| GET    | `/v1/codegraph/impact?id=`    | blast-radius impact                            |
| POST   | `/v1/feishu/webhook`          | Feishu event subscription (webhook transport)  |
| POST   | `/mcp`                        | MCP Streamable HTTP server                     |

---

## 🔌 Agent ecosystem compatibility

| Spec / API                              | Status                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Anthropic / OpenAI / Google / Bedrock   | via `pi-ai` (50+ models, OAuth for Anthropic / Codex / Copilot)         |
| OpenAI Chat Completions                 | via `pi-ai`'s `openai-completions` provider                              |
| OpenAI Responses API                    | via `pi-ai`'s `openai-responses` provider                                |
| **MCP** (Model Context Protocol)        | built-in Streamable HTTP server on `/mcp` (2025-03-26 spec)              |
| pi-mono extensions                      | `pi` key in `package.json` + `extensions/` dir — drop-in                 |
| pi-mono skills (SKILL.md)               | `skills/` dir — auto-discovered by `pi`                                  |
| pi-mom channel pattern                  | `FeishuMom` mirrors `SlackMom`'s architecture                            |
| TypeBox tool schemas                    | all 11 apex tools use `@sinclair/typebox` (mandatory for Google)        |
| Cross-provider hand-off                 | `pi-ai` natively supports it; we just pick a default model               |

---

## 🧬 Self-repair & natural-language learning

1. **Self-repair** — `agent.ts` subscribes to `tool_execution_end` with
   `isError: true`; on every failure it ingests a `procedural` record
   tagged `tool-error` so the dreamer sweep can spot recurring patterns.
2. **Natural-language feedback** — call `apex_feedback` with verdict
   `up` / `down` / `note` plus optional free-form text. Down-votes
   become high-importance `procedural` records; up-votes become
   low-importance `semantic` records. The next dreamer tick promotes
   repeated anti-patterns to long-term memory.
3. **Skill distillation** — call `apex_distill` after a successful
   multi-tool task; it writes a SKILL.md candidate to `SKILLS_DIR` so
   the next session inherits the pattern automatically.

---

## 📐 Resource budget (Bun, 256 MB target)

```
bun runtime                 30 MB
pi-ai + pi-agent-core       12 MB
apex-mem engine              4 MB
codegraph (sqlite + index)   5 MB
hono + json                  2 MB
feishu sdk (when enabled)   20 MB
agent headroom              60 MB
─────────────────────────────
TOTAL                      133 MB
free                        123 MB
```

---

## 📁 Layout

```
apex-pi/
├── package.json              # pi-mono + apex deps, "pi" manifest
├── src/
│   ├── agent.ts              # @earendil-works/pi-agent-core singleton
│   ├── cli.ts                # dispatch: http / feishu / mcp / one-shot
│   ├── config.ts             # env-driven config
│   ├── bootstrap.ts          # one-time init (memory, dreamer, skills)
│   ├── extensions/           # ← pi-mono extensions, drop-in
│   │   ├── host.ts           #   minimal ExtensionAPI shim
│   │   ├── memory.ts         #   apex_search/ingest/relate/stats/feedback/distill
│   │   ├── codegraph.ts      #   codegraph_search/callers/callees/impact
│   │   ├── understand.ts     #   understand_path
│   │   └── index.ts          #   bundle + INSTINCTS + BASE_PROMPT
│   ├── http/server.ts        # Hono SSE + REST
│   ├── mcp/server.ts         # MCP Streamable HTTP
│   ├── channels/feishu.ts    # FeishuMom (pi-mom pattern + official SDK)
│   ├── memory/               # apex-mem: SQLite FTS5 + graph + dreaming
│   ├── codegraph/            # regex symbol index
│   ├── understand/           # 5-phase pipeline
│   ├── skills/               # INSTINCTS + same-process SKILLS map
│   ├── log.ts
│   ├── json.ts
│   └── setup-check.ts
├── skills/                   # SKILL.md auto-loaded by `pi`
│   ├── security-audit/
│   ├── incident-triage/
│   └── release-checklist/
├── extensions/               # symlinked into `pi` on `pi install npm:apex-pi`
├── Dockerfile                # bun build + tini + ca-certs
├── Dockerfile                # multi-stage Bun build → linux-x64 binary
├── .github/workflows/
│   ├── ci.yml                # typecheck + test + build + docker
│   └── release.yml           # multi-arch Docker → GHCR
└── bunfig.toml
```

---

## License

MIT.
