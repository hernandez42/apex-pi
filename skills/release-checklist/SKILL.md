---
name: release-checklist
description: Pre-release verification for any project. Runs typecheck, tests, security audit, and produces a release note draft.
---

Before cutting a release:

1. `bash` `git status` to confirm a clean tree.
2. `bash` the project's typecheck command (look at `package.json` `typecheck`, `tsc --noEmit`, `mypy`, etc.).
3. `bash` the project's test command. If tests touch the network, prefix with `MOCK=1`.
4. `bash` the project's build command and verify the artefact path.
5. `codegraph_impact` on every public export that changed since the last tag: `git diff <last>..HEAD --name-only` → `codegraph_search` each → `impact`.
6. Draft release notes by summarising `git log <last>..HEAD --oneline` with file:line citations.
7. Output a checklist with green/red status; call out anything red as a release blocker.
