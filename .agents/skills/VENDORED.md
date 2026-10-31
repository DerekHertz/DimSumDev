# Vendored skills

## Caveman

Source: https://github.com/JuliusBrussee/caveman, `skills/caveman/`, pinned at `2178ed6495c3c0ecd7d037e60acf3b1d0c554b97` (adopted 2026-10-24). Apache-2.0; upstream LICENSE, NOTICE, LICENSE-MIT and LICENSING.md are retained in `caveman/`.

Default chat style, per user request. Local adaptations: short description, default-on integration note preserving required updates and evidence, removal of unavailable companion-mode/hook instructions, and a README note distinguishing the installed subset. The skill only changes communication; no hooks, runtime, compressor or companion skills are installed. CLAUDE.md and Codex working conventions establish the default; persisted artifacts retain normal prose. Changes to SKILL.md and README.md are local adaptations from the pinned upstream source.

## Cloudflare security-audit

Source: https://github.com/cloudflare/security-audit-skill, `skills/security-audit/`, pinned at `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (adopted 2026-10-24). MIT; the upstream root license is retained in `security-audit/LICENSE`.

Optional, user-invoked workflow; no role preload or mandatory audit stage. Local changes: shorten the description, set `disable-model-invocation: true`, and add the Den integration paragraph linking usage and existing authority boundaries; in `MEMORY-SAFETY-AND-BINARY.md`, one line says "interactive debugging" instead of the retired role's name (`role-definition-trim.test.mjs` forbids it). Companion references, schema, validators and their tests are unchanged. Update by diffing against the pin and reviewing changes; do not auto-update. See `docs/agents/security-audit.md`.

## mattpocock

Source: https://github.com/mattpocock/skills (MIT, see `MATTPOCOCK-LICENSE`)
Upstream commit: `c55ee46073ed923f86ce59a5eb3b6d895095d1b7` (2026-09-18); selected changes through `5beb35b` (2026-10-22) merged by hand on 2026-10-22, see "Merged since the pin".
Local clone for diffing: `vendor/mattpocock-skills/` (git-ignored). Update with `git -C vendor/mattpocock-skills pull`, then diff each skill against this folder.

`agents/` subfolders (other-tool metadata) were not copied.

| Skill | Status | Local changes |
|---|---|---|
| grilling (two older stub skills were folded into it, den-mvp/90) | **adapted** | Counts open questions per round; when the frontier grows for two rounds or a second area of fog opens, stops and offers a hand-off note to figure-it-out (den-mvp/60). |
| domain-modeling, codebase-design | as-is | none (codebase-design's front-matter description is shortened for the Codex preload budget) |
| prototype, research | **adapted** | Front-matter description shortened for the Codex preload budget; body as upstream. |
| tdd | **adapted** | Carries the post-pin seam note (what each seam catches and misses). Adds two pstack 0.15.36 rules: prefer no new test over a bad test (extra tests only; each criterion keeps its failing-before test), and report the failing-before and passing-after evidence. pstack tdd itself is not taken. |
| diagnosing-bugs | **adapted** | Adds a "where else does this cause exist" step after the cause is confirmed, and fixes at the cause's layer (hardening/02). Wording says "interactive debugging" and "next person" instead of the retired role's name (`role-definition-trim.test.mjs` forbids it). Carries the post-pin forced-mutation check. |
| wayfinder | **retired** 2026-10-31 | Replaced by pstack `figure-it-out` (see the pstack table). The grilling hand-off now points at it. |
| resolving-merge-conflicts, writing-for-agents | as-is | none |
| handoff | **adapted** | Model-invocable. Writes to the board (`.scratch/<feature>/handoffs/`) instead of the OS temp dir. Fixed sections, 60-line cap. |
| implement | **adapted** | Model-invocable. Claims the ticket via team-protocol, delegates verbose output to `runner`, never merges, ends with /handoff. |
| to-tickets | **adapted** | Model-invocable (chief of staff). Step 4 is a pass gate. Hardening/02: tickets carry type, Why, Out of scope, Cause and a token estimate (split above 150k, merge below 30k), about 5 done-when checks, an advisory paths line; the "avoid file paths" rule is gone. |
| to-spec | **adapted** | Model-invocable (product). Points at `docs/agents/issue-tracker.md`, not the upstream setup command (hardening/02). |
| code-review | **adapted** | Adds a Pro token-budget note (sonnet sub-agents, diff command not pasted, current ticket only). Points at `docs/agents/issue-tracker.md`, not the upstream setup command (hardening/02). |
| team-protocol | **new** | Shared agent rules: board, claims, gates, hand off and exit, token hygiene. |
| asset-critique | **new** | Visual critique rounds for rigged glb assets; `scripts/measure-glb.mjs` measures per-bone proportions. |
| browser-verify | **new** | Drives the den in a real browser with `npm run verify:ui` (trust-ladder/02); returns screenshots, errors, a perf trace and findings with repro steps. |

### Merged since the pin (2026-10-22)

Taken: grilling (yes-accepts wording), tdd (seam catches/misses note), diagnosing-bugs (forced-mutation `diff` check; the two wording edits kept and now documented in the table), wayfinder (label-only rule, real ids in cross-references, no PR for research branches, read the label), implement (fetch the ticket reference; Skill-tool wording), code-review (search for every standards file; foreground sub-agents).
Skipped: the `CONTEXT.md` to `GLOSSARY.md` rename (this repo uses `CONTEXT.md`), handoff and to-tickets changes (tracker-specific), `resolving-merge-conflicts` (removed upstream 2026-09-24; kept here). Not vendored: upstream `implement-spec`, `pr`, `retro`, `chief-of-staff`.

## pstack

Source: https://github.com/cursor/plugins, folder `pstack/` (MIT, Lauren Tan / poteto, see `PSTACK-LICENSE`). Checked 2026-10-22 at `4ec7ffa`; the 2026-10-31 adoptions are from pstack 0.15.36. The `automate-me` adaptation predates this record; its upstream commit was not kept.

| Skill | Status | Local changes | Who uses it |
|---|---|---|---|
| automate-me | **adapted** | Rewritten for Claude Code: `AskUserQuestion`, `runner` slices over `~/.claude/projects/`, `usage-watch` first, pruning through `writing-for-agents`. Drops Cursor's `create-skill` and `unslop` steps. | The user, on request |
| principle-laziness-protocol, principle-subtract-before-you-add, unslop | as-is (`disable-model-invocation` removed); the two principle skills' descriptions are shortened for the Codex preload budget | none else | developer, architect, code-reviewer (principles, in place of ponytail); technical-writer, herald (unslop) |
| blast-radius, correct | as-is, light edits | Companion skills `how`, `why`, `arena` replaced by git history and `interrogate`; "operator" is "user" | qa (preloaded); `pipeline-retro` names `correct` |
| show-me-your-work | **adapted** | Cursor transcript paths become `~/.claude/projects/<slug>`; cross-model review uses a different Claude tier; log kept under `$TMPDIR` in a read-only den run. `scripts/log.sh` as-is. | developer on L tickets and unattended runs |
| reflect | **adapted** | Three `runner` lenses replace the three Cursor reviewers and synthesizer reference files; the synthesis is done by the main session; edits wait for the user's approval. | The user, at the end of a long relay; `pipeline-retro` points to it |
| interrogate | **adapted** | Reviewer A is `code-reviewer`, B a different model (Codex when enabled); `rubric.md` and `lead-judgment.md` as-is; the Cursor model rule file and two prompt templates dropped. | security (preloaded) |
| no-comments | **adapted** | The `comment-sicko` agent and its `how`/`why`/`architect` dependencies are folded into one self-contained skill. | developer, before committing a large diff |
| how, why | **adapted** (0.15.36) | Model-invocable; Cursor Task and model slugs become Agent, Explore and the `~/.claude/rules/pstack-models.md` role lines (how explorer/explainer, why investigators/synthesizer). Sources swapped for git, `gh`, the board, ADRs, Claude transcripts. | architect |
| arena | **adapted** (0.15.36) | Model-invocable; runners and cross-judge from the `arena runners` and `arena cross-judge pool` lines; no Grok/Cursor families. | architect |
| architect | **adapted** (0.15.36) | Model-invocable; the architect role runs it as its process: ground with how, design twice in an arena, scrap rules. Adds codebase-design vocabulary and statechart for state machines; Phase D is the skeleton for the developer. `references/principles.md` collects 11 pstack principles as-is. | architect |
| figure-it-out | **adapted** (0.15.36) | Replaces wayfinder (retired 2026-10-31): a grilling hand-off note is the Phase A input, its settled decisions stand, its open questions become the first units, its destination becomes the predicate. `multi-phase-plan.md` is **rewritten** from poteto-mode's multi-phase playbook for the den relay (board tickets, no Cursor loop/Bugbot/swarm lanes). Its plan-writing style step is dropped on purpose: plans are checklists agents run, and the technical writer owns prose. | chief-of-staff, architect |
| statechart | **adapted** (0.15.36) | `scripts/` TypeScript tool copied with a Node-only port for native Windows: `statechart.mjs` replaces the `/bin/sh` shim (Node 22.18+ check; Bun and Deno dropped), `kill.ts` replaces the shell kill (`process.kill(-pid)` or `taskkill /T /F`), the janitor is a `node -e` script, `TEMP`/`TMP` join `TMPDIR`, `LC_ALL` is set on Linux only, CRLF output is read, `.exe` is added to a mise java path, and an empty `--out` folder is removed before the rename on Windows. package.json: test deps dropped, name `statechart`. No `scripts/test/`. The pinned TLC jar URL and sha256 are unchanged. SKILL.md gains a Platforms section; TLC and Java come from `mise` on first run, or `TLA2TOOLS` and `JAVA`. | architect |
| (ideas, not files) | folded | `team-protocol` lines (fresh subagent per round, idempotent retries, prove it by running) and qa's blast-radius step (den-mvp/90) | all roles |

Descriptions of the adopted skills, and of `code-review`, `automate-me`, `asset-critique`, `browser-verify`, `pipeline-retro` and `to-tickets`, were shortened so every Codex role stays under its 16 KB preload budget (the Codex test counts all skill descriptions).

Not taken: the other pstack skills (the `principle-*` set beyond those named above, `poteto-mode`, `swarm` and the rest).

### Dropped: ponytail (2026-10-22)

`ponytail` (DietrichGebert/ponytail, pinned `2961b52`) is removed, with `PONYTAIL-LICENSE`. The user's call: no local evidence that it helped or hurt, and a controlled comparison costs more than it is worth. Its `shortcut: <limit>, <when to upgrade>` comment convention and its "end every reply with what you skipped" line went with it. Replaced by `principle-laziness-protocol` and `principle-subtract-before-you-add` on developer, architect and code-reviewer; qa dropped it. If review quality or diff size slips, check the history of `.claude/agents/{developer,architect,code-reviewer}.md` from this date.

### Dropped: organism-protocol (2026-10-22)

The one-release stub from ADR 0028 is removed. Nothing in code, roles or skills named it; old run logs still show calls to it.

## jevgrep

Source: https://github.com/dzhng/jevgrep, `skills/jevgrep/SKILL.md`, in `.agents/skills/` only. Refreshed 2026-10-22 to `28cf384` (adds "Phrasing Queries"); the front-matter description is shortened to keep Codex roles under the 16 KB preload test. `skills-lock.json` still holds the old `computedHash`; the hash algorithm is the skills CLI's, so run `npx skills update` to refresh it.
