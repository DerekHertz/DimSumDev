# 13: `board` corrupts real tickets' bold status line; bound the write-lock wait

**What to build:** `board` works on real board tickets. Every ticket writes its status as `**Status:** <value>`, but the parser matches `Status:\s*(\S+)`, so it reads `**` as the status and rewrites the line as `**Status: <new> <old>`. `board release` did exactly this on ticket 02 on 2026-09-27; the orchestrator repaired the line by hand. Also make write-lock contention behave well: a cell that hits a live write lock waits with a bounded, jittered backoff, then fails with a clear message and a distinct exit code. It never blocks for long, never spins, and never steals the lock. A taken claim lock still fails fast.

**Blocked by:** None. Urgent: `organism-protocol` already tells cells to use `board`, so no cell that calls `claim` or `release` is dispatched until this merges.

**Status:** claimed

- [ ] Status is parsed and replaced in the real `**Status:** <value>` format, and the formatting is preserved. Also tolerate plain `Status:`. Tested with fixtures copied from real tickets.
- [ ] `from_status`/`to_status` in `events.jsonl` hold real values, never `**`
- [ ] Only the ticket's header status line is ever read or replaced. A `Status:` inside comments or body text is ignored (tested).
- [ ] Write-lock contention: bounded wait (a few seconds total) with jittered backoff; then a clear error and a distinct exit code. Tested with a held live lock (fails in bounded time) and a lock released mid-wait (succeeds).
- [ ] Concurrent `comment`/`release` on one ticket from several processes: all succeed or fail cleanly, no lost updates, no corrupted file (tested)
- [ ] A taken claim lock still fails fast (no waiting)

## Comments

- **Created (orchestrator, 2026-09-27):** Found by dogfooding `board release` right after PR #15 merged. qa's fixtures used plain `Status:`, so all 19 tests passed without ever seeing the real format. The user wants no race conditions, and no agent blocked or spinning while it waits on a lock.
