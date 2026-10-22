---
name: show-me-your-work
description: "Keep a TSV decision log (what, why, evidence, result) for L tickets, overnight runs, or work reviewed after the fact."
---

# Show me your work

Keep one canonical log: a TSV file, one row per decision. Cells are single-line. Evidence is a pointer, never prose.

Columns (`references/decision-log-template.tsv` holds the header):

- **ts.** ISO8601 timestamp.
- **phase.** The phase or workstream.
- **decision.** What was chosen or done, one line.
- **why.** The reason in plain words.
- **evidence.** Commit SHA, PR number, `file:line`, or an artifact path.
- **result.** The outcome: `tests green`, `reverted`, `INCONCLUSIVE`, `open`.

## Logging a row

Write each row the way you would tell a teammate what you did: concrete actions, plain words (the `unslop` rules apply). Use `scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result>`. It stamps `ts`, writes the header on first use, strips stray tabs and newlines, and quotes any cell that starts with `=`, `+`, `-` or `@`.

Log decision points and checkpoints, not every action: a fork chosen, a unit finished with its verification result, a pivot or revert with its trigger, a blocker, a gate. In a loop, one row per iteration.

A run is one agent conversation. A pickup, a replacement agent or a new session starts a new run. A run that adds to a log with rows already in it opens with a row of phase `start`: its decision names the `ts` range of earlier rows this run did not write, and its evidence names this run (an agent id). Use phase `start` for nothing else.

## Where it lives

A working artifact, not committed: `decisions.tsv` in the work dir, or `.audit/<task-slug>.tsv` when several efforts run at once. Inside a den run the repo may be read-only; keep the log under `$TMPDIR` and put its path in the handoff. Commit it only when a reviewer needs the trail to trust the result.

## Rules

- Append-only. A wrong call gets a new row that supersedes it.
- Prefer evidence from committed scripts over one-off commands.

## Before you hand back

1. **Audit the log against what happened.** Read this run's transcript under `~/.claude/projects/<workspace-slug>/` (this workspace only; sibling directories hold private chats). Check that each row maps to a real decision, that its evidence resolves, and that no fork or abandoned approach is missing. Fix the log by adding rows that supersede wrong ones; never edit or delete a row.
2. **Cross-model review.** Start a subagent on a different model tier from the one that did the work (a Codex `scout` reading the log and transcript, or `code-reviewer`). It flags weak or missing evidence, steps claimed without proof, and choices that look risky in hindsight. Self-review is not a substitute.
3. End your report with an "Attention" section: `reviewed by <model>` on its own line, then each flag with the row or moment it points to. "No flags" is a valid value.

Other skills route their audit trail here and let this skill own the format.

<!-- Adapted from pstack show-me-your-work (MIT, Lauren Tan). See .claude/skills/VENDORED.md. -->
