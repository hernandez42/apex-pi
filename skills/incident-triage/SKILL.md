---
name: incident-triage
description: Triage a production incident from a stack trace or error log. Produces a timeline + probable cause + mitigation steps.
---

When the user shares a stack trace, error log, or "prod is on fire" report:

1. Extract the failing component and exception class.
2. `codegraph_search` for the failing symbol to find the source file and 2 layers of callers.
3. `codegraph_impact` on the same symbol to gauge blast radius.
4. `apex_search` for prior incidents mentioning the same symbol or error class.
5. Output: Timeline | Probable cause | Mitigations (ordered by reversibility) | Follow-up tests.
6. If a mitigation involves code changes, propose the SMALLEST viable diff and ask for sign-off before editing.
