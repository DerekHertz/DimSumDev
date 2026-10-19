# Starting an agent at the previous hop's commit

Agent-tool worktrees always start detached at `main`. Each relay hop must build on the prior hop's commit, so dispatch puts one command in the agent's prompt instead of manual git steps:

```
node scripts/cell-start.mjs --base <sha> --branch <name> --ticket <ref> --cell developer            # developer: starts on qa's tests commit
node scripts/cell-start.mjs --base <sha> --detach --ticket <ref> --cell qa --mode verify            # qa verify: detached at the developer's commit
node scripts/cell-start.mjs --base <sha> --detach --ticket <ref> --cell security                    # security
```

The agent runs it first, inside its worktree. It:

0. Reads the orchestrator's context (`scripts/context.mjs`; an agent shares the orchestrator's `CLAUDE_CODE_SESSION_ID`, organism-infra/119). At 70k or more it prints a warning that the orchestrator should start no new tickets. At 80k or more it refuses with exit 1 (`orchestrator context <n>k ≥ 80k: write the session handoff and ask the user to /compact`) before claiming or switching anything. `--force` skips the refusal. `--continue`, for a fix round or a later hop of a ticket already in flight, gets the warning but never the refusal. A null reading never blocks.

These numbers are the orchestrator's budget, from `scripts/context-budget.json`. Every agent role has a separate budget in the same file: warn at 100k, stop at 150k (organism-infra/220), enforced by the PreToolUse hook and read by `scripts/context.mjs --self`. A role with no entry gets the file's `default` (100k and 150k).
1. Refuses (non-zero exit, reason on stderr, nothing changed) in the main checkout, in a dirty worktree (untracked files count), for an unknown `<sha>`, for an existing `<name>`, or for bad arguments.
2. Switches to a new branch at `<sha>`, or detaches there.
3. Runs `npm ci` with cwd at the worktree's toplevel; a failure exits non-zero. A base commit with no root `package.json` is refused before switching, because npm would otherwise walk up and reinstall in the main checkout.
4. With `--ticket <ref> --cell <type> [--mode <m>]`, runs `board claim <ref> <type> [--mode <m>]`. A refused claim exits non-zero with the board's message: the agent does no work on that ticket. `--ticket` needs `--cell`; `--cell` and `--mode` need `--ticket`. Without `--ticket` nothing is claimed, and the agent claims by hand as before.

Notes (not implemented):

- `npm ci` runs lifecycle scripts and reads `.npmrc` from the commit under review. Today's lockfile has none. For security and qa-verify hops, an `--ignore-scripts` option is worth considering; it is a trade-off left to the orchestrator.
- The value check rejects `--x` but accepts `-x` at parse time; git refuses such values later, so it is harmless. `v.startsWith("-")` would be tighter.

After it succeeds, pass the worktree's absolute path as `path` on every Grep and Glob call. Without it, those tools search the main checkout, not your worktree. When your tool list has no Grep or Glob, run `grep -rn` and `find` through Bash from inside the worktree instead.

Keep it a single plain command so the isolation guard allows it. The orchestrator takes `<sha>` from the prior hop's handoff.
