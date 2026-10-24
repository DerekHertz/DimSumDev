---
name: team-protocol
description: Rules every den role follows under Codex: claim one ticket, stop at gates, hand off, end. Read before touching the board.
---

# Team protocol (Codex)

Terms are in `CONTEXT.md`; role contracts in `docs/agents/team-charter.md`. Do one ticket, then end. Scope added in a ticket's `## Comments` counts as acceptance criteria.

## Board

The board is `.scratch/<feature>/` in the main checkout (`$DEN_ROOT`, else the first path of `git worktree list`). Never edit tickets by hand; use these:
- `npm run board -- claim <feature>/<NN-slug> <role> [--mode m]`: one agent per ticket; fails if taken. Never delete another agent's lock. qa passes `--mode verify`.
- `npm run board -- comment <ref> "<text>" [--verdict pass|bounce]`: short text; detail goes in the handoff. Reviewers (`code-reviewer`, `qa`, `security`) write their verdict with `--verdict`.
- `npm run board -- status <ref>`: read a ticket's status.
- `npm run board -- handoff <ref> --template`, then `npm run board -- handoff <ref> --from /tmp/<file>.md --name <NN>-<role>.md`: draft under `/tmp`, never in a worktree.
- Every role files discovered work as a new ticket instead of chasing it: `.scratch/<feature>/issues/<NN>-<slug>.md`, format in `docs/agents/issue-tracker.md`, a Why naming the filer; `Status: ready-for-agent` only if it touches nothing on the user-merge list (Gates), else `ready-for-human` with a `**Question:**`; name it in your handoff.
- Pickup: ask "Can I work on <ref>?" (top ready ticket, why, estimate); start on yes. A user-approved queue (tickets the user listed, not agent-filed ones) skips the ask.
- `npm run board -- release <ref> --status <resolved|blocked|in-review> [--reason "..."]`: needs a handoff published after your claim. On a code ticket a developer releases at `in-review`; reviewers leave the status alone; the chief of staff resolves it after the merge.

## Relay

Every code ticket runs the developer (failing tests first, each criterion mapped to its test), `code-reviewer` and qa `verify`, `npm run risk-check`, then `security` on a hit. The risk path is `.claude/`, `CLAUDE.md`, ADRs, the wall, CI, hooks, service, auth and dependencies; qa has no `specify` mode. The developer never reviews its own work. Push, PR and merge are the release manager's steps (the bridge in a den delivery; the chief of staff in a terminal relay, once the user approved the ticket). Other roles never do them.

## Gates

Stop and ask the user before: pushing, opening a PR or merging; deleting files outside the ticket; adding a dependency; changing an ADR, `CONTEXT.md` or `CLAUDE.md`; editing anything under `.claude/` (write a patch to `.scratch/_handoffs/gated/<NN>-<slug>.patch` and name it in your handoff); and anything your role lists. State the action, why, and what changes. The user also keeps: merging a change on the user-merge list (bridge, guardrails, scripts, CI), visual verdicts before merge, a twice-failed ticket, 5-hour usage at 90%+, and any open scope question.

## Handoff

Open with the outcome, then a few lines of evidence (commands run, exit codes), changed files, open items and the smallest remaining decision. Final report: verdict, branch, SHA, numbers, handoff pointer, and worktree path (clean or dirty). Report environment failures (tool, exact error, suggested fix) instead of working around them.

## End

Commit on your branch (a WIP commit, never a stash), stop background processes, release the ticket, then stop. Do not start a second ticket. An agent that launches subagents waits for their reports before it hands off or ends. A retry brief is the ticket, the cause note and a failure summary (~10 lines max), never transcript excerpts.

In a worktree, run `npm ci` first, give every long command a `timeout`, and keep shell calls plain. Write prose files with the file tool, not a heredoc.
