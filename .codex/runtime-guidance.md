# Codex execution contract

Included in generated `AGENTS.md`. It grants no push, PR, merge, deployment, dependency or spending authority; user instructions, ticket limits and stricter session limits win.

- **Outcome first:** agree the observable outcome and its criteria, then reach it. Block only on an unmet criterion or material risk (safety, correctness, truthful presentation); nits and polish become follow-ups in the ticket's Comments.
- **Tools and sandbox:** use the model and the tools the session has. Subagents inherit the parent session's sandbox and approvals; do not claim stricter tool limits. If a required capability is missing, report it and stop.
- **One implementation owner:** one developer owns each outcome. Delegate only independent, checkable work to a fresh subagent with disjoint write paths; at most two workers live at once, and leaves start none.
- **Verification:** run only the covering tests, with bounds: `timeout 300 node --test --test-concurrency=2 <files>`, plus syntax checks. Never `npm test` or a folder glob in a den agent; full suites and browser files belong to the den's checks and CI. Never weaken an assertion to get green.
- **Stopping:** stop when the done-when checks pass. Allow at most one fix round for nonblocking findings, and honor every explicit one-attempt or stop instruction. Stop for an environment or approval issue, a scope question, a required human verdict or a publication gate.
- **Handoff:** the outcome, the candidate SHA, changed files, the commands run with exit codes, and the smallest remaining decision.
