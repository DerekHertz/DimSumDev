# Vendored skills

Source: https://github.com/mattpocock/skills (MIT, see `MATTPOCOCK-LICENSE`)
Upstream commit: `c55ee46073ed923f86ce59a5eb3b6d895095d1b7` (2026-09-18)
Local clone for diffing: `vendor/mattpocock-skills/` (git-ignored). Update with `git -C vendor/mattpocock-skills pull`, then diff each skill against this folder.

`agents/` subfolders (other-tool metadata) were not copied.

| Skill | Status | Local changes |
|---|---|---|
| grilling (two older stub skills were folded into it, den-mvp/90) | **adapted** | Counts open questions per round; when the frontier grows for two rounds or a second area of fog opens, stops and offers a hand-off note to wayfinder (den-mvp/60). |
| domain-modeling, codebase-design | as-is | none |
| tdd, prototype, research | as-is | none |
| diagnosing-bugs | **adapted** | Adds a "where else does this cause exist" step after the cause is confirmed, and fixes at the cause's layer (hardening/02). |
| wayfinder | **adapted** | Chart step 1 starts from a grilling hand-off note when given one, and records it as a closed `grilling` ticket (den-mvp/60). Points at `docs/agents/issue-tracker.md`, not the upstream setup command (hardening/02). |
| resolving-merge-conflicts, writing-for-agents | as-is | none |
| handoff | **adapted** | Model-invocable. Writes to the board (`.scratch/<feature>/handoffs/`) instead of the OS temp dir. Fixed sections, 60-line cap. |
| implement | **adapted** | Model-invocable. Claims the ticket via team-protocol, delegates verbose output to `scout`, never merges, ends with /handoff. |
| to-tickets | **adapted** | Model-invocable (orchestrator). Step 4 is a pass gate. Hardening/02: tickets carry type, Why, Out of scope, Cause and a token estimate (split above 150k, merge below 30k), about 5 done-when checks, an advisory paths line; the "avoid file paths" rule is gone. |
| to-spec | **adapted** | Model-invocable (product). Points at `docs/agents/issue-tracker.md`, not the upstream setup command (hardening/02). |
| code-review | **adapted** | Adds a Pro token-budget note (sonnet sub-agents, diff command not pasted, current ticket only). Points at `docs/agents/issue-tracker.md`, not the upstream setup command (hardening/02). |
| team-protocol | **new** | Shared agent rules: board, claims, gates, hand off and exit, token hygiene. |
| asset-critique | **new** | Visual critique rounds for rigged glb assets; `scripts/measure-glb.mjs` measures per-bone proportions. |

## ponytail

Source: https://github.com/DietrichGebert/ponytail (MIT, see `PONYTAIL-LICENSE`)
Upstream commit: `2961b52fc1fe6a5a87c7a959a79512e5c2f3ffe5` (2026-10-13), file `.openclaw/skills/ponytail/SKILL.md`.

| Skill | Status | Local changes |
|---|---|---|
| ponytail | as-is | none. Preloaded by developer, qa and architect: the smallest complete change, and `shortcut: <limit>, <when to upgrade>` comments for known limits. The upstream review, audit and debt skills were not copied. |
