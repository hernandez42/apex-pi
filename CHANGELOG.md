# Changelog

All notable changes to **apex-pi** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-05

### Added

- Initial public release of **apex-pi**.
- **pi-mono** core: OpenAI-compatible LLM client (`src/llm/`), agent
  tool-calling loop with streaming SSE (`src/agent/`), full type parity with
  `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` for the parts we
  actually use.
- **apex-mem** (TS reimplementation): 5D memory (working / episodic /
  semantic / procedural / declarative), SQLite FTS5, knowledge graph, hybrid
  retrieval (BM25 + lexical + graph BFS + RRF), dreaming sweep, APEX doctor.
  Wire-compatible with `hernandez42/APEX-MEM` (Rust) — same JSON-RPC
  tool names and `MemoryRecord` shape. Swap in the Rust binary by setting
  `APEXMEM_URL`.
- **codegraph** (`src/codegraph/`): regex-based symbol index, callers /
  callees / impact. Singleton-backed, ~5 MB RSS.
- **/understand** (`src/understand/`): 5-phase pipeline (scan → analyze →
  tour → hotspots → explain) that compresses the 6-agent design of
  `Lum1104/Understand-Anything` into a single LLM call.
- **ECC skills** (`src/skills/`): 6 always-on instincts (security, RTK
  token economy, research-first, no-destruction, smallest-viable-diff,
  narrate-while-working) and 5 skills (brainstorm, review, verify, rtk,
  socratic). Pluggable via `SKILLS_DIR=<dir-of-SKILL.md>`.
- **Feishu / Lark channel** (`src/channels/feishu.ts`): official
  `@larksuiteoapi/node-sdk` lazy-imported; webhook mounted on the same
  port as the REST API.
- **Hono HTTP server** with endpoints: `GET /`, `GET /healthz`,
  `GET /readyz`, `GET /v1/stats`, `GET /v1/graph`,
  `POST /v1/chat` (SSE), `POST /v1/memories`, `POST /v1/memories/search`,
  `POST /v1/understand`, `POST /v1/codegraph/index`,
  `GET /v1/codegraph/search`, `GET /v1/codegraph/impact`,
  `POST /v1/feishu/webhook`.
- **Web UI** (`web/index.html`, inlined into the bundle via
  `with: { type: "text" }` import attribute): streaming chat, dark/light
  theme, tool-call visualisation, `/stats` and `/graph` buttons.
- **CLI** (`src/cli.ts`): `apex-pi` (start server), `apex-pi "…"`
  (one-shot), `apex-pi --repl`, `apex-pi --feishu`, `apex-pi --understand`,
  `apex-pi --ingest`, `apex-pi --search`, `apex-pi --stats`.
- **Fly.io deployment**: multi-stage `Dockerfile` (~80 MB on the wire),
  `fly.toml` (256 MB, shared CPU, auto-stop), `scripts/deploy.sh` that
  persists `.env` as Fly secrets, creates a 1 GB persistent volume.
- **Test suite**: `bun test` covers the apex-mem engine, codegraph and the
  LLM client.

### Tuned for the Fly.io free tier

- Idle RSS ≤ 80 MB on a stock 256 MB machine.
- 1 GB NVMe budget (image + DBs).
- `auto_stop_machines = "stop"` + `min_machines_running = 0` so the free
  tier doesn't burn hours.
- All hot paths are zero-dep: `bun:sqlite` (no better-sqlite3 compile),
  native `fetch` (no axios), Hono (no Express), regex (no tree-sitter).
