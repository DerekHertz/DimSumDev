---
name: team-protocol
description: The shared rules every Agent Office agent follows. Covers claiming tickets on the file board, pass gates, handoffs, hand off and exit, and token hygiene. Preloaded into every role; read it before touching the board.
---

Before working, read `.codex/runtime-guidance.md` for the Codex execution contract. Shared safety and approval gates, explicit ticket limits and stricter session constraints still apply.

You are an **agent** in the Agent Office org. Terms are defined in `CONTEXT.md`. Your role definition (your `.claude/agents/<role>.md` file) sets your team, tools, skills, gates, and done criteria. Stay inside it. Every role's contract (inputs, outputs, authority, who gets its work next) and the user's approval points are in `docs/agents/team-charter.md` (ADR 0029).

Your first message states your role and ticket, e.g. `[role: developer | ticket: ci-cd/02]`, so telemetry can attribute the session.

For Codex, use the model and effort configured in `.codex/agents/<role>.toml`, subject to availability and session limits. Never silently substitute a Claude tier or another runtime.

## Delegation

- **Hierarchy:** Bao (Claude) or Jiao (Codex) owns the task, with up to four managers and up to four runners per manager. This three-level tree is a maximum shape, never mandatory spawning. Managers scope work, review their runners' evidence and hand it up; runners and scout leaves start no agents. A role's tools and the session's actual delegation capabilities still control what it can start.
- **Model tiers:** the purpose is model-tier utilization. Keep planning, design, demanding review and final judgment on capable configured owner/manager models; give cheaper runners bounded, checkable execution. The parent verifies their evidence. Use the role's configured model and effort, within actual availability; if a needed model is unavailable, report it and wait or stop rather than silently downgrade demanding review or switch runtimes. This hierarchy changes no role's configured model or review floor.
- **Concurrency:** for a small task, default to the owner alone or one helper; required independent reviews still run. Add live workers only for useful independent scopes, settled interfaces and disjoint write paths. Choose concurrency separately from topology and model routing, within explicit task, runtime, session, usage and resource limits; the strictest applicable limit wins. There is no universal two-worker ceiling and no entitlement to extra slots.
- **Current bridge:** `apps/bridge/agents/policy.mjs` still enforces two worker slots shared across Claude and Codex, plus one orchestrator slot and one scout slot; these are bridge process classes, not manager/runner layers. Resource groups and the usage stop still apply. This guidance changes no enforced limits. For fixed-revision tree proposals, approval, implemented workflow and remaining conformance gates, read `docs/agents/task-trees.md`. Changing enforced limits needs its existing approval, and a runtime without nested delegation must sequence or hand off within its capabilities.

Your final report to the orchestrator stays under about 300 words: the verdict, the branch, the numbers, and a pointer to the handoff for details. Claim only results you actually ran. Send verbose work (full test runs, log reading, merge checks) through `scout`, or after `04` a local model.

## The board

- The board is the local issue tracker described in `docs/agents/issue-tracker.md`: `.scratch/<feature-slug>/` in the **main checkout**.
- If you run in a worktree, the main checkout is at `$DEN_ROOT`. If that is unset, it is the path `git worktree list` prints first. Always read and write the board there, never in your worktree's copy.
- Scope added in a ticket's `## Comments` (for example "Scope added (user, ...)") counts as acceptance criteria, just like the checkboxes. qa maps every scope item to a test, and the developer covers each one.
- A ticket is ready when its `Status:` is `ready-for-agent` and every ticket in `Blocked by:` is `resolved`.

## Claiming a ticket (exactly one agent per ticket)

1. Claim with `npm run board -- claim <feature>/<NN-slug> <role>`. It creates the lock atomically, sets `Status: claimed` (a `security` or `qa --mode verify` claim on an `in-review` ticket keeps `in-review`), and fails if another agent holds the ticket. Moded agents need `--mode`: qa must pass `specify` or `verify`; designer passes `review`, `spec`, `critique` or `direction` (a designer verdict needs `review`). Other agents need no mode. A dispatch line with `agent-start --ticket <ref> --role <role> [--mode <m>]` makes this claim for you (`docs/agents/agent-start.md`).
2. If the claim fails, the ticket is taken: pick another or hand off. Never delete another agent's lock.
3. Add comments with `npm run board -- comment <feature>/<NN-slug> "<text>"`, never by editing the ticket. With a lock held, the author is your lock's agent. With no lock, pass `--as <role>`; with a lock, `--as` must match your agent.
   - Take over a dead holder's lock with `board reclaim <ref> <role> --reason "..."`, never as `orchestrator`. Free a lock without changing status with `board release <ref> --keep-status`.
4. On finish, `npm run board -- release <feature>/<NN-slug> --status <resolved|blocked|in-review> [--reason "..."]`. On a code ticket, agents in the review relay (`developer`, `code-reviewer`, `qa`, `security`) never set `resolved`: a developer releases at `in-review`, and `code-reviewer`, `qa` and `security` leave the status as it is and write their verdict with `board comment <ref> --verdict pass|bounce "<text>"`. The `--verdict` flag is what the bounce count reads (ADR 0008 decision 12); a verdict in the text alone doesn't count.

## Relay size (den-mvp/71)

The relay is sized to risk. A **risk-path** ticket changes `.claude/`, `CLAUDE.md`, `docs/adr/`, the wall (`apps/bridge/agents/{limits,governance,ceilings}.json`, `apps/bridge/library/connections.json`, any guardrail path `scripts/risk-check.mjs` lists, `apps/bridge/agents/`), CI (`.github/`), a hook or guard script, service or auth code, or a dependency. It runs the full relay: qa `specify`, developer, `code-reviewer`, qa `verify` (light), `npm run risk-check`, and `security` on a hit. Every other ticket (tests, docs, UI, ordinary scripts and code) takes the **light path**: no qa `specify`. The developer dispatches directly, writes the tests first and lists each criterion's test in its handoff. Then `code-reviewer` reads the diff, and qa `verify` (full, fresh context) writes a per-criterion map to a test that fails without the change, and a verdict on each hit of `node scripts/test-guard.mjs`. Then `risk-check`, and `security` on a hit. When unsure, the orchestrator takes the full relay and says why.

**Independent review (ADR 0029).** Every code ticket gets the `code-reviewer` (the diff: standards, design, spec fit) and qa (behaviour) at the same candidate commit, and the developer no longer reviews its own work. Both run before a fix round, so the developer gets one round with both sets of findings; a new commit runs both again, and a second fix round pauses the ticket as failed twice. Push, PR and merge are the release manager's steps: the bridge runs them in a den delivery, the orchestrator in a terminal relay. This section gives way to the planner's floor when team-and-den-ux/17 lands: each ticket then calls only the roles its type and paths need.

## Pass gates (stop and ask the user)

Always ask before:
- merging to `main`, pushing, or opening a PR. Exception (organism-infra/158): the orchestrator may push a commit on `main` that touches only `.scratch/` (board state) straight to `origin/main`, without asking. Code still goes through a PR, and merges stay a gate. `board release` pushes an agent's own branch as part of the release, which is not a separate gate
- deleting files outside your ticket's scope
- adding a dependency
- changing an ADR, `CONTEXT.md` or `CLAUDE.md`
- changing anything under `.claude/` (role definitions, skills, settings). Only the orchestrator edits it, with the user's permission; other agents write the change as a patch to `.scratch/_handoffs/gated/<NN>-<slug>.patch` in the main checkout and name it in their handoff. The user applies it with `!npm run apply-gated` (see `docs/agents/gated-patches.md`).
- anything your role definition lists under `gates`

State the action, why, and what changes. Wait for an explicit yes.

**Relay autonomy (user, 2026-09-29):** once the user approves a ticket, the orchestrator runs its whole relay end to end without asking again. That covers dispatching each stage, opening the PR, and merging on green CI with no conflicts. Every other gate above still applies to every agent. The orchestrator stops and asks only when the user is needed:
- a user verdict (`ready-for-human`, a browser or visual check)
- a scope, design or requirements question the spec doesn't answer
- a ticket failing twice
- an environment issue
- 5-hour usage at 90% or more
- a merge that is red, conflicted or diverged

Moving on to the next ticket on the frontier needs a yes, unless the user has approved a queue.

**Batches (user, 2026-09-30):** the orchestrator may run several small tickets in the same area as one batch: one relay, one branch, one PR (orchestrator role definition, "Batches"). An agent dispatched on a batch claims every ticket in it, publishes its handoff on each, and releases each. qa specify writes tests for every ticket and maps each criterion to its ticket. One bounce on any ticket bounces the whole batch and counts toward fails-twice for each of its tickets. A batch grants no additional capacity: each live process counts against its runtime's admission limits.

## Environment issues (report, don't work around)

When the environment gets in your way, don't patch or improvise past it. Examples: a missing or failing tool, a dev server that hangs or serves the wrong MIME type, a port in use, or a permission denial. End your report with an `Environment issues` section: what failed, the exact error, and the fix you suggest. The user fixes these in the main session. If one stops your task, say so and stop.

**Log every failed call and blocker, even ones you got past on a retry.** That includes permission or classifier refusals, "no verdict" errors, worktree-guard rejections, commands that exit non-zero or fail to parse, timeouts, and workarounds. Your final report ends with a `Failed calls` list, one line each: the tool, the command (short), the exact error, what you did instead, and your guess whether it's a genuine guardrail or fixable friction. Never write "refusals: none" if anything failed. The orchestrator appends each one to `.scratch/usage.jsonl` as `kind:"incident"`, so they can be analyzed.

Handoffs go through `board` too. The `handoff` skill shows the State block that `board release` validates, and `board handoff <ref> --template` prints one already filled in for your claim. Draft the file under `/tmp` (`board handoff` refuses a draft inside a worktree), then run `board handoff <ref> --from <file> --name <NN>-<role>.md`. It publishes the file to the main checkout's `.scratch/<feature>/handoffs/`. Never write handoffs into the main checkout by shell or Write, and never leave a copy in your worktree. `board release`, including `--keep-status`, refuses without a handoff published after your claim.

## Shell and git

- Write prose (handoffs, comments, markdown) with the Write tool or node `fs.writeFileSync`, never a shell heredoc (`npm test` rejects BOMs in `.md`/`.json`). Prefer `fs.rmSync` / `fs.copyFileSync` over `rm` / `cp` for files outside your worktree, and `git checkout -- <path>` to revert.
- Read ticket status with `board status <ref>`, never by grepping the markdown. Keep `board comment` text short; put detail in the handoff.
- Never `git commit -a` in the main checkout; stage explicit paths. Give every `git push` a timeout.
- In a worktree, one plain command per Bash call: no `cd`, no `&&` or `;` chains, no pipes into git, no heredocs, and no shell variables (`$X`) in arguments. Write literal paths. For multi-line content or a multi-step probe, Write a script into your scratchpad and run it with `node <path>`. The isolation guard rejects everything else, and each refusal costs a turn.
- Run `npm ci` first in a fresh worktree.
- Give every long-running command (tests, dev servers, browser automation, installs, `gh pr checks --watch`) an explicit timeout that fits the work: a few minutes for a suite, about 15 for CI. When it fires, stop: don't retry or keep waiting. Report it under `Environment issues` with the command, the bound, and the last output.

## Context budget (organism-infra/119)

Every call re-reads your whole context, so a smaller one costs less. Thresholds live in `scripts/context-budget.json`: every agent role warns at 100k and stops at 150k (organism-infra/220); the orchestrator warns at 70k and stops at 80k (organism-infra/208). At every stage boundary (tests written, tests green, before review, before commit, and before any long read), run `node scripts/context.mjs --self --role <your role>`. It prints your own transcript's `context_tokens` and a `state`; `context_tokens: null` means no reading, so carry on. `ok` means carry on. Follow `state`:

- **`warn`:** finish the current stage. Start no new exploration and no new stage you can leave to a fresh agent.
- **`stop`:** stop. Commit your work in progress on the branch (a WIP commit, never a stash). Publish a handoff that says exactly what is done and what is left, run `board release` (keep the ticket's current status), and end your report with `outcome: partial`. The orchestrator re-dispatches a fresh agent of your type on the same branch with your handoff; that counts as the same round, not a bounce. Put your last reading in your final report as `final context: <n>`; the orchestrator logs it with `log-agent.mjs --context <n>`.

## Hand off and exit (ending well)

An agent does one ticket or one task, then ends. When your role definition's `done` criteria are met, or you are blocked, or your context is getting long:
1. Commit your work to your branch (dev agents only). Stop any dev servers or background processes you started, and leave no lingering locks or `git stash` entries (use a WIP commit instead of stashing). See `docs/agents/process-hygiene.md`.
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
- Follow "Delegation" above for the shared hierarchy, model routing and task-adaptive concurrency.
