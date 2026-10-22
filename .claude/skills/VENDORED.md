# Vendored skills

Source: https://github.com/mattpocock/skills (MIT, see `MATTPOCOCK-LICENSE`)
Upstream commit: `c55ee46073ed923f86ce59a5eb3b6d895095d1b7` (2026-09-18); selected changes through `5beb35b` (2026-10-22) merged by hand on 2026-10-22, see "Merged since the pin".
Local clone for diffing: `vendor/mattpocock-skills/` (git-ignored). Update with `git -C vendor/mattpocock-skills pull`, then diff each skill against this folder.

`agents/` subfolders (other-tool metadata) were not copied.

| Skill | Status | Local changes |
|---|---|---|
| grilling (two older stub skills were folded into it, den-mvp/90) | **adapted** | Counts open questions per round; when the frontier grows for two rounds or a second area of fog opens, stops and offers a hand-off note to wayfinder (den-mvp/60). |
| domain-modeling, codebase-design | as-is | none |
| tdd, diagnosing-bugs, prototype, research | as-is | none (tdd and diagnosing-bugs carry the post-pin seam note and forced-mutation check; the `GLOSSARY.md` rename is not taken) |
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

Taken: grilling (yes-accepts wording), tdd (seam catches/misses note), diagnosing-bugs (forced-mutation `diff` check; two wording edits reverted so the copy is as-is again), wayfinder (label-only rule, real ids in cross-references, no PR for research branches, read the label), implement (fetch the ticket reference; Skill-tool wording), code-review (search for every standards file; foreground sub-agents).
Skipped: the `CONTEXT.md` to `GLOSSARY.md` rename (this repo uses `CONTEXT.md`), handoff and to-tickets changes (tracker-specific), `resolving-merge-conflicts` (removed upstream 2026-09-24; kept here). Not vendored: upstream `implement-spec`, `pr`, `retro`, `chief-of-staff`.

## pstack

Source: https://github.com/cursor/plugins, folder `pstack/` (MIT, Lauren Tan / poteto, see `PSTACK-LICENSE`). Checked 2026-10-22 at `4ec7ffa`. The `automate-me` adaptation predates this record; its upstream commit was not kept.

| Skill | Status | Local changes | Who uses it |
|---|---|---|---|
| automate-me | **adapted** | Rewritten for Claude Code: `AskUserQuestion`, `scout` slices over `~/.claude/projects/`, `usage-watch` first, pruning through `writing-for-agents`. Drops Cursor's `create-skill` and `unslop` steps. | The user, on request |
| principle-laziness-protocol, principle-subtract-before-you-add, unslop | as-is (`disable-model-invocation` removed) | none | developer, architect, code-reviewer (principles, in place of ponytail); technical-writer, herald (unslop) |
| blast-radius, correct | as-is, light edits | Companion skills `how`, `why`, `arena` replaced by git history and `interrogate`; "operator" is "user" | qa (preloaded); `pipeline-retro` names `correct` |
| show-me-your-work | **adapted** | Cursor transcript paths become `~/.claude/projects/<slug>`; cross-model review uses a different Claude tier; log kept under `$TMPDIR` in a read-only den run. `scripts/log.sh` as-is. | developer on L tickets and unattended runs |
| reflect | **adapted** | Three `scout` lenses replace the three Cursor reviewers and synthesizer reference files; the synthesis is done by the main session; edits wait for the user's approval. | The user, at the end of a long relay; `pipeline-retro` points to it |
| interrogate | **adapted** | Reviewer A is `code-reviewer`, B a different model (Codex when enabled); `rubric.md` and `lead-judgment.md` as-is; the Cursor model rule file and two prompt templates dropped. | security (preloaded) |
| no-comments | **adapted** | The `comment-sicko` agent and its `how`/`why`/`architect` dependencies are folded into one self-contained skill. | developer, before committing a large diff |
| (ideas, not files) | folded | `team-protocol` lines (fresh subagent per round, idempotent retries, prove it by running) and qa's blast-radius step (den-mvp/90) | all roles |

Descriptions of the adopted skills, and of `code-review`, `automate-me`, `asset-critique`, `pipeline-retro` and `to-tickets`, were shortened so every Codex role stays under its 16 KB preload budget (the Codex test counts all skill descriptions).

Not taken: the other 36 pstack skills (the `principle-*` set beyond the two above, `poteto-mode`, `statechart`, `swarm`, `arena` and the rest).

### Dropped: ponytail (2026-10-22)

`ponytail` (DietrichGebert/ponytail, pinned `2961b52`) is removed, with `PONYTAIL-LICENSE`. The user's call: no local evidence that it helped or hurt, and a controlled comparison costs more than it is worth. Its `shortcut: <limit>, <when to upgrade>` comment convention and its "end every reply with what you skipped" line went with it. Replaced by `principle-laziness-protocol` and `principle-subtract-before-you-add` on developer, architect and code-reviewer; qa dropped it. If review quality or diff size slips, check the history of `.claude/agents/{developer,architect,code-reviewer}.md` from this date.

### Dropped: organism-protocol (2026-10-22)

The one-release stub from ADR 0028 is removed. Nothing in code, roles or skills named it; old run logs still show calls to it.

## jevgrep

Source: https://github.com/dzhng/jevgrep, `skills/jevgrep/SKILL.md`, in `.agents/skills/` only. Refreshed 2026-10-22 to `28cf384` (adds "Phrasing Queries"). `skills-lock.json` still holds the old `computedHash`; the hash algorithm is the skills CLI's, so run `npx skills update` to refresh it.
