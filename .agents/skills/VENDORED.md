# Vendored skills

Source: https://github.com/mattpocock/skills (MIT, see `MATTPOCOCK-LICENSE`)
Upstream commit: `c55ee46073ed923f86ce59a5eb3b6d895095d1b7` (2026-09-18); selected changes through `5beb35b` (2026-10-22) merged by hand on 2026-10-22, see "Merged since the pin".
Local clone for diffing: `vendor/mattpocock-skills/` (git-ignored). Update with `git -C vendor/mattpocock-skills pull`, then diff each skill against this folder.

`agents/` subfolders (other-tool metadata) were not copied.

| Skill | Status | Local changes |
|---|---|---|
| grilling (two older stub skills were folded into it, den-mvp/90) | **adapted** | Counts open questions per round; when the frontier grows for two rounds or a second area of fog opens, stops and offers a hand-off note to wayfinder (den-mvp/60). |
| domain-modeling, codebase-design | as-is | none |
| prototype, research | as-is | none |
| tdd, diagnosing-bugs | as-is plus wording | diagnosing-bugs says "interactive debugging" and "next person" instead of the retired role's name (`role-definition-trim.test.mjs` forbids it). Both carry the post-pin seam note and forced-mutation check; the `GLOSSARY.md` rename is not taken) |
| wayfinder | **adapted** | Chart step 1 starts from a grilling hand-off note when given one, and records it as a closed `grilling` ticket (den-mvp/60). |
| resolving-merge-conflicts, writing-for-agents | as-is | none |
| handoff | **adapted** | Model-invocable. Writes to the board (`.scratch/<feature>/handoffs/`) instead of the OS temp dir. Fixed sections, 60-line cap. |
| implement | **adapted** | Model-invocable. Claims the ticket via team-protocol, delegates verbose output to `scout`, never merges, ends with /handoff. |
| to-tickets | **adapted** | Model-invocable (orchestrator). Step 4 is a pass gate. |
| to-spec | **adapted** | Model-invocable (product). |
| code-review | **adapted** | Adds a Pro token-budget note (sonnet sub-agents, diff command not pasted, current ticket only). |
| team-protocol | **new** | Shared agent rules: board, claims, gates, hand off and exit, token hygiene. |
| asset-critique | **new** | Visual critique rounds for rigged glb assets; `scripts/measure-glb.mjs` measures per-bone proportions. |

### Merged since the pin (2026-10-22)

Taken: grilling (yes-accepts wording), tdd (seam catches/misses note), diagnosing-bugs (forced-mutation `diff` check; the two wording edits kept and now documented in the table), wayfinder (label-only rule, real ids in cross-references, no PR for research branches, read the label), implement (fetch the ticket reference; Skill-tool wording), code-review (search for every standards file; foreground sub-agents).
Skipped: the `CONTEXT.md` to `GLOSSARY.md` rename (this repo uses `CONTEXT.md`), handoff and to-tickets changes (tracker-specific), `resolving-merge-conflicts` (removed upstream 2026-09-24; kept here). Not vendored: upstream `implement-spec`, `pr`, `retro`, `chief-of-staff`.

## pstack

Source: https://github.com/cursor/plugins, folder `pstack/` (MIT, Lauren Tan / poteto). Upstream commit when `automate-me` was adapted was not recorded; checked 2026-10-22 at `4ec7ffa`.

| Skill | Status | Local changes |
|---|---|---|
| automate-me | **adapted** | Rewritten for Claude Code: `AskUserQuestion`, `scout` slices over `~/.claude/projects/`, `usage-watch` first, pruning through `writing-for-agents`, lands via PR. Drops Cursor's `create-skill` and `unslop`. |
| (ideas, not files) | folded | A few `team-protocol` lines (fresh subagent per round, idempotent retries, prove it by running) and qa's blast-radius step, from den-mvp/90. |

## jevgrep

Source: https://github.com/dzhng/jevgrep, `skills/jevgrep/SKILL.md`, in `.agents/skills/` only. Refreshed 2026-10-22 to `28cf384` (adds "Phrasing Queries"). `skills-lock.json` still holds the old `computedHash`; the hash algorithm is the skills CLI's, so run `npx skills update` to refresh it.

## ponytail

Source: https://github.com/DietrichGebert/ponytail (MIT, see `PONYTAIL-LICENSE`)
Upstream commit: `2961b52fc1fe6a5a87c7a959a79512e5c2f3ffe5` (2026-10-13), file `.openclaw/skills/ponytail/SKILL.md`.

| Skill | Status | Local changes |
|---|---|---|
| ponytail | as-is | none. Preloaded by developer, qa and architect: the smallest complete change, and `shortcut: <limit>, <when to upgrade>` comments for known limits. The upstream review, audit and debt skills were not copied. |
