# Engineering terms replace the biology vocabulary

**Status:** proposed. The user accepts it by merging its PR. It renames terms used in every ADR before it. Those ADRs stay as written, each with a one-line note pointing here.

**Context.** The den started as an "organism": agents were cells, their definition files were genomes, groups of them were stations, and an agent ending on purpose was apoptosis. The metaphor made the early design easy to talk about, but it costs every new reader a translation step, and it reads oddly next to the engineering roles the team charter adds (code reviewer, release manager, SRE, technical writer; team-and-den-ux/02). The user chose to rename the vocabulary to plain engineering terms everywhere, code included (`.scratch/team-and-den-ux/spec.md`, decision 2; ticket team-and-den-ux/01). The choices below were put to the user on 2026-10-19 and are their answers.

## Decision

1. **The mapping.**

   | Old | New |
   |---|---|
   | organism | the org |
   | cell | agent |
   | cell type | role |
   | genome | role definition |
   | station | team |
   | apoptosis | hand off and exit |
   | endocrine limits | org limits |

   Bao stays the chief of staff. The den's own names stay, now as team names: the Pass, Steamers, Tea & Pantry and Front of House. The UI names in `CONTEXT.md` (panda, recipe card, clocking out, the den) do not change.
2. **Two PRs.** The first renames the words: `CONTEXT.md`, `CLAUDE.md`, `docs/`, the skills (`organism-protocol` becomes `team-protocol`), the role definitions in `.claude/agents/`, UI labels and this ADR. The second renames code: identifiers, the `apps/bridge/cells/` and `apps/organism-infra/` directories, scripts such as `cell-start`, the board CLI's terms and flags, the router, hooks and test names. Each one can be reviewed and rolled back on its own.
3. **Old CLI spellings still work.** The board CLI and the relay scripts accept the old spellings (`--cell`, a `<cell>` positional) and print one line naming the new spelling. Tests pin that line.
4. **Write new, read both.** New handoffs, events, lock files and API payloads use the new names (`role:`, `role`, `DEN_ROOT`). Readers still accept the old ones (`cell:`, `cellType`, `ORGANISM_ROOT`), so board files already on disk parse and a running den keeps working. A test reads a handoff written before the rename.
5. **Ticket refs are IDs.** `organism-infra` stays the name of its board feature, and refs such as `organism-infra/168` stay as written in comments and docs.
6. **Dated records stay as written.** Like ADRs, a document named for its date records what was true then: `docs/research/*-<date>.md`, `docs/refocus/`, `docs/design/<date>-*.md` and `design-brief.md` (draft v0.2, 2026-09-29).
7. **A stub for one release.** `.claude/skills/organism-protocol/SKILL.md` points at `team-protocol`, so anything that still loads the old name finds the rules. It is removed one release after the rename.

## Deliberate leftovers

The acceptance grep (`genome|apoptosis|\bcell(s|-type)?\b|organism`, outside `docs/adr/`, `.git` and `node_modules`) returns only these:

- the dated records in decision 6, and the ADR notes pointing here;
- `organism-infra/<n>` ticket refs (decision 5);
- the read-side fallbacks in decision 4 and the deprecation lines in decision 3, with their tests and the pre-rename fixtures they read;
- the `organism-protocol` stub (decision 7);
- tests that assert the old words are gone (for example the UI copy check in `apps/ui/src/overlay/floating-cards.test.mjs`);
- Jev eval cases (`scripts/jev-evals/**/cases.jsonl`), which are labelled historical inputs: editing them would change the eval;
- "cell" in its other senses (a table cell, a grid cell).

`station` is outside the acceptance grep. In prose and UI copy it becomes "team". In code, `station` identifiers (the scene layout, `STATION_HUE`, the `--station-*` colour tokens) stay as they are: the full-window shell (team-and-den-ux/04) rebuilds that code and renames them there.

## Consequences

- One translation step goes away for every reader, human or agent, and the new roles in team-and-den-ux/02 fit the vocabulary without a metaphor.
- Between the two PRs, the docs say "agent" and "role" while the code still says `cell` and `cellType`. The second PR closes that gap.
- The read-both fallbacks and the stub are kept code. They can go once no board file or caller uses the old names.
