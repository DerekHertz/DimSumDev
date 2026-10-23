---
name: rundown
description: "A rundown of where the den stands: open action items, what merged, what went wrong, what went well, what needs merging, and what to work on next. Use when the user asks for a rundown, a daily plan, 'what's going on', or 'what should we tackle'. Any time of day."
---

Gather, then report. Read only; do not claim, merge or file anything.

## Gather

The board lives in `.scratch/` in the **main checkout**, not in a worktree. Commands below already resolve it; for direct file reads use `ROOT=$(git worktree list --porcelain | sed -n '1s/^worktree //p')`.

Default window: since the last rundown in `$ROOT/.scratch/rundowns/` (newest file), else 24 hours. The user may name another window.

Run these in parallel:

1. `npm run -s queue`: ready (circled numbers are the proposed order), in flight, waiting on you, blocked.
2. `npm run -s board -- audit`: board hygiene findings.
3. `gh pr list --state merged --limit 30 --json number,title,mergedAt`, then keep those with `mergedAt` after `<since>` (the `merged:` search qualifier returns nothing here).
4. `gh pr list --state open --json number,title,isDraft,mergeable,statusCheckRollup,headRefName`
5. `gh run list --branch main --limit 15 --json conclusion,name,createdAt,url`: red runs on main.
6. Friction rows in `$ROOT/.scratch/den-mvp/friction.md` added or still `Open` in the window (`grep -n "| Open"`; `git -C $ROOT/.scratch log --since=<since> -p -- den-mvp/friction.md` for new ones).
7. Usage: the `usage-watch` skill's reading for the active provider.

Skip a source that fails and name it under **Gaps**; never guess its contents.

## Report

Lead with one line: the single most useful thing to do next, and why. Then these sections, each a short list, empty ones omitted:

- **Waiting on you**: decisions, merges, `ready-for-human` tickets with their question. Each says the action, e.g. "merge #412 (green)".
- **Needs merging**: open PRs, with check status and conflicts. Green and mergeable ones first.
- **Merged**: PRs in the window, one line each, linked.
- **Went wrong**: red CI on main, bounced or twice-failed tickets, new or open friction rows, audit findings that matter (stale locks, `no-lock` in-review tickets). Group audit noise (for example "11 tickets lack a Goal line") into one line.
- **Went well**: merges, resolved friction, tickets that went through on the first pass. Real items only; omit the section if there are none.
- **To work on**: the top 3 to 5 ready tickets in the queue's proposed order, plus any in-flight ticket with no lock (it may be abandoned). Note which pairs could run in parallel (non-overlapping files).
- **Usage**: the 5-hour and weekly percentages, with the source.
- **Gaps**: sources that failed.

Link PRs as `[owner/repo#N](url)`. Use ticket refs as `feature/NN`. Keep the whole report readable in under a minute.

Then write the report to `$ROOT/.scratch/rundowns/YYYY-MM-DD-HHMM.md` so the next rundown knows its window, and ask what to pick up with the AskUserQuestion tool, offering the top ready tickets.
