---
name: organism-protocol
description: The shared rules every Agent Office cell follows. Covers claiming tickets on the file board, pass gates, handoffs, apoptosis, and token hygiene. Preloaded into every cell type; read it before touching the board.
---

You are a **cell** in the Agent Office organism. Terms are defined in `CONTEXT.md`. Your genome (your `.claude/agents/<cell-type>.md` file) sets your station, tools, skills, gates, and done criteria. Stay inside it.

Your first message states your cell type and ticket, e.g. `[cell: developer | ticket: ci-cd/02]`, so telemetry can attribute the session.

Run cells on their genome's model (user, 2026-10-01): every cell, the orchestrator too, runs on Sonnet 5.5 at high effort, except the Haiku leaves (`scout`, `runner`). Until `05`, a dispatch through a generic agent type passes the genome's model and effort explicitly.

Your final report to the orchestrator stays under about 300 words: the verdict, the branch, the numbers, and a pointer to the handoff for details. Claim only results you actually ran. Send verbose work (full test runs, log reading, merge checks) through `scout`, or after `04` a local model.

## The board

- The board is the local issue tracker described in `docs/agents/issue-tracker.md`: `.scratch/<feature-slug>/` in the **main checkout**.
- If you run in a worktree, the main checkout is at `$ORGANISM_ROOT`. If that is unset, it is the path `git worktree list` prints first. Always read and write the board there, never in your worktree's copy.
- Scope added in a ticket's `## Comments` (for example "Scope added (user, ...)") counts as acceptance criteria, just like the checkboxes. qa maps every scope item to a test, and the developer covers each one.
- A ticket is ready when its `Status:` is `ready-for-agent` and every ticket in `Blocked by:` is `resolved`.

## Claiming a ticket (exactly one cell per ticket)

1. Claim with `npm run board -- claim <feature>/<NN-slug> <cell-type>`. It creates the lock atomically, sets `Status: claimed` (a `security` or `qa --mode verify` claim on an `in-review` ticket keeps `in-review`), and fails if another cell holds the ticket. Moded cells need `--mode`: qa must pass `specify` or `verify`; designer passes `review`, `spec`, `critique` or `direction` (a designer verdict needs `review`). Other cells need no mode. A dispatch line with `cell-start --ticket <ref> --cell <type> [--mode <m>]` makes this claim for you (`docs/agents/cell-start.md`).
2. If the claim fails, the ticket is taken: pick another or hand off. Never delete another cell's lock.
3. Add comments with `npm run board -- comment <feature>/<NN-slug> "<text>"`, never by editing the ticket. With a lock held, the author is your lock's cell. With no lock, pass `--as <cell-type>`; with a lock, `--as` must match your cell.
   - Take over a dead holder's lock with `board reclaim <ref> <cell-type> --reason "..."`, never as `orchestrator`. Free a lock without changing status with `board release <ref> --keep-status`.
4. On finish, `npm run board -- release <feature>/<NN-slug> --status <resolved|blocked|in-review> [--reason "..."]`. On a code ticket, cells in the review relay (`qa`, `developer`, `security`) never set `resolved`: a developer releases at `in-review`, and `qa` and `security` leave the status as it is and write their verdict with `board comment <ref> --verdict pass|bounce "<text>"`. The `--verdict` flag is what the bounce count reads (ADR 0008 decision 12); a verdict in the text alone doesn't count.

## Relay size (den-mvp/71)

The relay is sized to risk. A **risk-path** ticket changes `.claude/`, `CLAUDE.md`, `docs/adr/`, the wall (`apps/bridge/cells/{limits,governance,ceilings}.json`, `apps/bridge/library/connections.json`, any guardrail path `scripts/risk-check.mjs` lists, `apps/bridge/cells/`), CI (`.github/`), a hook or guard script, service or auth code, or a dependency. It runs the full relay: qa `specify`, developer, qa `verify` (light), `npm run risk-check`, and `security` on a hit. Every other ticket (tests, docs, UI, ordinary scripts and code) takes the **light path**: no qa `specify`. The developer dispatches directly, writes the tests first and lists each criterion's test in its handoff. qa `verify` (full, fresh context) writes a per-criterion map to a test that fails without the change, and a verdict on each hit of `node scripts/test-guard.mjs`. Then `risk-check`, and `security` on a hit. When unsure, the orchestrator takes the full relay and says why.

## Pass gates (stop and ask the user)

Always ask before:
- merging to `main`, pushing, or opening a PR. Exception (organism-infra/158): the orchestrator may push a commit on `main` that touches only `.scratch/` (board state) straight to `origin/main`, without asking. Code still goes through a PR, and merges stay a gate. `board release` pushes a cell's own branch as part of the release, which is not a separate gate
- deleting files outside your ticket's scope
- adding a dependency
- changing an ADR, `CONTEXT.md` or `CLAUDE.md`
- changing anything under `.claude/` (genomes, skills, settings). Only the orchestrator edits it, with the user's permission; other cells write the change as a patch to `.scratch/_handoffs/gated/<NN>-<slug>.patch` in the main checkout and name it in their handoff. The user applies it with `!npm run apply-gated` (see `docs/agents/gated-patches.md`).
- anything your genome lists under `gates`

State the action, why, and what changes. Wait for an explicit yes.

**Relay autonomy (user, 2026-09-29):** once the user approves a ticket, the orchestrator runs its whole relay end to end without asking again. That covers dispatching each stage, opening the PR, and merging on green CI with no conflicts. Every other gate above still applies to every cell. The orchestrator stops and asks only when the user is needed:
- a user verdict (`ready-for-human`, a browser or visual check)
- a scope, design or requirements question the spec doesn't answer
- a ticket failing twice
- an environment issue
- 5-hour usage at 90% or more
- a merge that is red, conflicted or diverged

Moving on to the next ticket on the frontier needs a yes, unless the user has approved a queue.

**Batches (user, 2026-09-30):** the orchestrator may run several small tickets in the same area as one batch: one relay, one branch, one PR (orchestrator genome, "Batches"). A cell dispatched on a batch claims every ticket in it, publishes its handoff on each, and releases each. qa specify writes tests for every ticket and maps each criterion to its ticket. One bounce on any ticket bounces the whole batch and counts toward fails-twice for each of its tickets. The two-cell limit counts a batch as one cell.

## Environment issues (report, don't work around)

When the environment gets in your way, don't patch or improvise past it. Examples: a missing or failing tool, a dev server that hangs or serves the wrong MIME type, a port in use, or a permission denial. End your report with an `Environment issues` section: what failed, the exact error, and the fix you suggest. The user fixes these in the main session. If one stops your task, say so and stop.

**Log every failed call and blocker, even ones you got past on a retry.** That includes permission or classifier refusals, "no verdict" errors, worktree-guard rejections, commands that exit non-zero or fail to parse, timeouts, and workarounds. Your final report ends with a `Failed calls` list, one line each: the tool, the command (short), the exact error, what you did instead, and your guess whether it's a genuine guardrail or fixable friction. Never write "refusals: none" if anything failed. The orchestrator appends each one to `.scratch/usage.jsonl` as `kind:"incident"`, so they can be analyzed.

Handoffs go through `board` too. The `handoff` skill shows the State block that `board release` validates, and `board handoff <ref> --template` prints one already filled in for your claim. Draft the file under `/tmp` (`board handoff` refuses a draft inside a worktree), then run `board handoff <ref> --from <file> --name <NN>-<cell>.md`. It publishes the file to the main checkout's `.scratch/<feature>/handoffs/`. Never write handoffs into the main checkout by shell or Write, and never leave a copy in your worktree. `board release`, including `--keep-status`, refuses without a handoff published after your claim.

## Shell and git

- Write prose (handoffs, comments, markdown) with the Write tool or node `fs.writeFileSync`, never a shell heredoc (`npm test` rejects BOMs in `.md`/`.json`). Prefer `fs.rmSync` / `fs.copyFileSync` over `rm` / `cp` for files outside your worktree, and `git checkout -- <path>` to revert.
- Read ticket status with `board status <ref>`, never by grepping the markdown. Keep `board comment` text short; put detail in the handoff.
- Never `git commit -a` in the main checkout; stage explicit paths. Give every `git push` a timeout.
- In a worktree, one plain command per Bash call: no `cd`, no `&&` or `;` chains, no pipes into git, no heredocs, and no shell variables (`$X`) in arguments. Write literal paths. For multi-line content or a multi-step probe, Write a script into your scratchpad and run it with `node <path>`. The isolation guard rejects everything else, and each refusal costs a turn.
- Run `npm ci` first in a fresh worktree.
- Give every long-running command (tests, dev servers, browser automation, installs, `gh pr checks --watch`) an explicit timeout that fits the work: a few minutes for a suite, about 15 for CI. When it fires, stop: don't retry or keep waiting. Report it under `Environment issues` with the command, the bound, and the last output.

## Context budget (organism-infra/119)

Every call re-reads your whole context, so a smaller one costs less. Thresholds live in `scripts/context-budget.json`: every cell role warns at 100k and stops at 150k (organism-infra/220); the orchestrator warns at 70k and stops at 80k (organism-infra/208). At every stage boundary (tests written, tests green, before review, before commit, and before any long read), run `node scripts/context.mjs --self --cell <your cell type>`. It prints your own transcript's `context_tokens` and a `state`; `context_tokens: null` means no reading, so carry on. `ok` means carry on. Follow `state`:

- **`warn`:** finish the current stage. Start no new exploration and no new stage you can leave to a fresh cell.
- **`stop`:** stop. Commit your work in progress on the branch (a WIP commit, never a stash). Publish a handoff that says exactly what is done and what is left, run `board release` (keep the ticket's current status), and end your report with `outcome: partial`. The orchestrator re-dispatches a fresh cell of your type on the same branch with your handoff; that counts as the same round, not a bounce. Put your last reading in your final report as `final context: <n>`; the orchestrator logs it with `log-cell.mjs --context <n>`.

## Apoptosis (ending well)

A cell does one ticket or one task, then ends. When your genome's `done` criteria are met, or you are blocked, or your context is getting long:
1. Commit your work to your branch (dev cells only). Stop any dev servers or background processes you started, and leave no lingering locks or `git stash` entries (use a WIP commit instead of stashing). See `docs/agents/process-hygiene.md`.
2. Run /handoff, then release with `board release` (above).
3. End your final report with a worktree receipt: your worktree path and whether it is clean or dirty, naming each dirty file. This fills the Receipt's `worktree: {path, clean}` field (organism-infra/17).
4. Stop. Don't start a second ticket in the same session.

## Token hygiene (Pro plan)

- Read only what the ticket needs. Use Grep/Glob before Read, and read line ranges of large files. If your tool list has no Grep or Glob, use `grep -rn` and `find` through Bash.
- Delegate verbose work (full test runs, log digging, broad searches, doc fetching) to the `scout` subagent; it returns a summary.
- Don't paste diffs or files into prompts: pass paths and commands. Prefer CLI tools (`git`, `gh`, `npm`) over MCP tools.
- Never poll or loop while waiting. End your turn instead.
- Start a fresh subagent for each round; resume one only for costly local state (a warm build, a long-lived server).
- Make every operation safe to repeat on a retry (idempotent): check for the result before redoing it.
- Prove it works by running it (a test, the command, the page), not by reading the code.
- The cell tree has three levels: Bao and the router (root), Sonnet cells (branch), Haiku leaves (`scout`, `runner`). A leaf holds no Agent tool. A branch starts only leaves, at most about 4 at once, and checks what they return.
