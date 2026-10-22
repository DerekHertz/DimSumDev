---
name: team-protocol
description: Rules every den role follows under Codex: claim one ticket on the board, stop at gates, hand off, end. Read before touching the board.
---

# Team protocol (Codex)

Terms are in `CONTEXT.md`; role contracts in `docs/agents/team-charter.md`. Do one ticket, then end. Scope added in a ticket's `## Comments` counts as acceptance criteria.

## Board

The board is `.scratch/<feature>/` in the main checkout (`$DEN_ROOT`, else the first path of `git worktree list`). Never edit tickets by hand; use these (all via `npm run board -- <cmd>`):
- `npm run board -- claim <feature>/<NN-slug> <role> [--mode m]`: one agent per ticket; fails if taken. Never delete another agent's lock. qa passes `--mode specify|verify`.
- `npm run board -- comment <ref> "<text>" [--verdict pass|bounce]`: short text; detail goes in the handoff. Reviewers (`code-reviewer`, `qa`, `security`) write their verdict with `--verdict`.
- `npm run board -- status <ref>`: read a ticket's status.
- `npm run board -- handoff <ref> --template`, then `npm run board -- handoff <ref> --from /tmp/<file>.md --name <NN>-<role>.md`: draft under `/tmp`, never in a worktree.
- `npm run board -- release <ref> --status <resolved|blocked|in-review> [--reason "..."]`: needs a handoff published after your claim. On a code ticket a developer releases at `in-review`; reviewers leave the status alone; the orchestrator resolves it after the merge.

## Relay

A risk-path ticket (`.claude/`, `CLAUDE.md`, ADRs, the wall, CI, hooks, service, auth, dependencies) runs qa `specify`, developer, `code-reviewer` and qa `verify`, `npm run risk-check`, then `security` on a hit. Any other ticket skips `specify`: the developer writes the tests first and maps each criterion to its test. The developer never reviews its own work. Push, PR and merge are the release manager's steps (the bridge in a den delivery; the orchestrator in a terminal relay, once the user approved the ticket). Other roles never do them.

## Gates

Stop and ask the user before: pushing, opening a PR or merging; deleting files outside the ticket; adding a dependency; changing an ADR, `CONTEXT.md` or `CLAUDE.md`; editing anything under `.claude/` (write a patch to `.scratch/_handoffs/gated/<NN>-<slug>.patch` and name it in your handoff); and anything your role lists. State the action, why, and what changes.

## Handoff

Open with the outcome. Evidence is a few lines: the commands run and their exit codes. List open items and the smallest remaining decision. Final report: verdict, branch, SHA, numbers, handoff pointer, and your worktree path with clean or dirty. Report environment failures (tool, exact error, suggested fix) instead of working around them.

## End

Commit on your branch (a WIP commit, never a stash), stop background processes, release the ticket, then stop. Do not start a second ticket.

In a worktree, run `npm ci` first, give every long command a `timeout`, and keep shell calls plain. Write prose files with the file tool, not a heredoc.
