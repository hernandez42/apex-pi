---
name: security-audit
description: Audit a codebase for OWASP Top 10 + secrets + unsafe dependencies. Produces a prioritised report with file:line citations.
---

When the user asks for a security audit:

1. Run `codegraph_search` for keywords: `password`, `secret`, `token`, `api_key`, `crypto`, `exec`, `eval`, `sql`, `template`.
2. For each match, `read` the file and inspect: hardcoded credentials, SQL string concatenation, dynamic `eval` / `Function`, unvalidated redirects, weak crypto (MD5/SHA1/RC4), missing input validation.
3. `bash` `npm audit --omit=dev` (or `pip-audit` / `cargo audit`) for dependency CVEs.
4. Cross-reference with `apex_search` query `security anti-pattern` to surface past findings.
5. Output a Markdown table: Severity | File:Line | Issue | Recommended fix.
6. After delivery, call `apex_feedback` only if the user reacted; do not auto-record.
