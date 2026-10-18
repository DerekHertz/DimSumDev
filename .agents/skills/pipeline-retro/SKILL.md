---
name: pipeline-retro
description: Find repeated hiccups in the relay (handoff, board, guard, CI failures) and turn each into one fix, preferring code over wording. Orchestrator only. Use at the end of every orchestrator session, after every 3 resolved tickets, or when the user asks what keeps going wrong.
---

Run this in the main orchestrator session. The goal is fewer repeat failures per ticket, not a complete record. Wording has already failed twice this project: a rule that existed in a skill was still broken by most cells. So prefer a code fix whenever one exists.

## 1. Gather (since the last retro)

The last retro is the newest `{"kind":"retro"}` row in `.scratch/usage.jsonl`. With no such row, start from the beginning of the current session.

- The output of `npm run -s board -- audit` (read-only; exit 1 means findings). Each line is one board inconsistency, `<ref> <kind> <detail>`. Count each as an item, and fix the board state it names only with the user's yes.
- `incident` rows in `.scratch/usage.jsonl` since then. Rows with `"source":"cell-report"` come from `log-cell --failures`.
- `failures` in the State block of each handoff published since then (`.scratch/*/handoffs/`), and any "Failed calls" or "Environment issues" lines. Read only the State block and those lines, not the whole handoff. If there are more than 10 handoffs, send the gathering to `scout` and ask for just the list.
- Your own mistakes this session that you haven't logged yet. Log them now as `incident` rows.

## 1b. Review what earlier retros filed

Retro tickets pile up unbuilt. On 2026-10-11, 28 of the 64 tickets that retros had filed were parked, and several were duplicates of each other.

- Take every ticket ref in the `fixes` of all `retro` rows and look up its status in `npm run -s board -- list`. Skip a ref that is not a ticket name.
- For each one that is not `resolved` or `closed`, pick one recommendation:
  - **unpark:** its cause happened again since the last retro.
  - **close as duplicate:** another open or parked ticket has the same cause. Name the one to keep.
  - **close:** code merged since then already removes the cause.
  - **keep:** none of the above.
- Before step 3 proposes a new ticket, search this list for the same cause. If one exists, propose unparking it. Never file a second ticket for the same cause.

## 2. Group

Map each item to one tool from the fixed list in `scripts/log-cell.mjs`: `bash-guard`, `board-claim`, `board-release`, `board-comment`, `board-handoff`, `handoff-state`, `git`, `npm`, `write`, `ci`, `other`. Older rows use free-text tool names, so map those by meaning. Within a tool, group by cause, not wording. For example, "compound command refused" and "heredoc refused" are both `bash-guard`.

## 3. Decide

A cause is a candidate if it has happened 3 or more times in all, counting incidents from before the last retro (refocus guardrail, user 2026-10-12: pipeline tickets only from a third repeat), or if it has a `rule_change` from an earlier retro and happened again, which means that fix failed.

Pick the first fix that applies:

1. **Code:** the board, a script, or a CLI flag can refuse or automate it. Examples: `board release` writing the resolved row, `--verdict` refusing without a lock. File a ticket.
2. **Dispatch template:** the orchestrator's own prompt caused it. Examples: a paraphrased schema, a missing path. Edit the orchestrator genome.
3. **Genome or skill wording:** only when neither 1 nor 2 fits. Put the fix in the one place the cell will read at the moment it acts, and don't duplicate it elsewhere.
4. **Nothing:** a genuine guardrail that did its job, or a one-off. Say so.

A fix that already failed as wording goes to code, or to the user as an open question. It never gets a second wording.

## 3b. Look beyond the incidents

These three checks need no repeat count. Limit them to the genomes and skills of the cells that ran since the last retro, and propose at most three items in total.

- **Steering-file trim:** a rule in a genome, a skill or `CLAUDE.md` that a script, hook or board command now enforces, or that names something removed, does nothing. Propose deleting it.
- **Review-side rules:** when a developer keeps missing a judgement rule, propose moving it to the genome of the cell that reviews the work (`qa` verify or `security`). Do not reword it in the developer genome.
- **Missing guardrail:** when no existing check could have caught an incident, propose the check (a hook, a CI step, a board refusal) as a code fix, even at a count of one.

## 4. Report and apply

Show the user one table: cause, tool, count, tickets affected, proposed fix and its kind. Keep it under 15 rows. Ask with AskUserQuestion which fixes to apply.

- Show a second table for step 1b: ticket, status, recommendation, reason. Run `board unpark` or `board close` only on the tickets the user picks.
- Apply approved genome and skill edits on `main` and commit them (`.claude/` edits are user-gated; the yes covers them).
- File approved code fixes as tickets.
- Append one `{"kind":"retro","ts","window_from","items","fixes":[{"cause","tool","kind","ref"}]}` row, where `ref` is the commit or ticket. Don't rewrite old incident rows. The next retro reads `fixes` to check whether each fix held.
