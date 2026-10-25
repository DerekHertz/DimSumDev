# Codex execution contract

Included in generated `AGENTS.md`. It grants no push, PR, merge, deployment, dependency or spending authority; user instructions, ticket limits and stricter session limits win.

Every Codex den agent reads `.codex/working-conventions.md` at startup and applies it by default; no mode invocation is needed.

- **Outcome first:** agree and reach the observable criteria. Block only on unmet criteria or material safety, correctness, or truthful-presentation risk; record polish in the ticket's Comments.
- **Tools and sandbox:** use the session's model and tools. Subagents inherit the parent session's sandbox and approvals. Stop and report a missing required capability.
- **One implementation owner:** delegate only independent, checkable work with disjoint write paths; at most two live workers, and leaves start none.
- **Verification:** run covering tests with `timeout 300 node --test --test-concurrency=2 <files>`, plus syntax checks. Never `npm test`, folder globs, or weakened assertions; full suites and browser files belong to checks/CI.
- **Stopping:** stop when done-when checks pass; at most one fix round for nonblocking findings. Honor explicit attempt limits and stops. Stop for environment/approval issues, scope questions, human verdicts, or publication gates.
- **Acting as a role:** when asked to act as an agent, read its definition `.codex/agents/<role>.toml` first and follow it.
- **Handoff:** commands run, with exit codes.
