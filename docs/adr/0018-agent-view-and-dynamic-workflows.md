# Adopt agent view for cell dispatch and dynamic workflows for the relay, as optional local paths behind the existing seams

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** accepted (user, 2026-10-02, as written; numbered 0018 because ADR 0017 is meetings and decision briefs. architect-style draft from a user request, 2026-10-02: "transition to agent view and dynamic workflows as in https://code.claude.com/docs/en/agents"). Scope chosen by the user: plan and ADR only, no runtime code. Nothing here supersedes ADR 0002 or 0016 until the user accepts it.

**Context.** The Claude Code docs now list five ways to run work in parallel. Two matter here:

- **Agent view** (research preview): `claude agents`, `claude --bg [--agent <cell>] "<prompt>"`, `claude agents --json`, `claude attach|logs|stop|respawn|rm <id>`. A supervisor keeps sessions alive without a terminal. A background session moves into a git worktree under `.claude/worktrees/` before its first edit. It commits without asking, and pushes when a remote exists, but never to `main`/`master`, never force-pushes, never merges unless told. It runs locally only, and a usage-limit wait does not apply to it. Turn it off with `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` or `"disableAgents": true`.
- **Dynamic workflows**: a JavaScript script (`export const meta`, then `agent()`, `pipeline()`, `parallel()`, `phase()`, `log()`, global `args`) saved in `.claude/workflows/` and run as `/<name>`. The script, not Claude, holds the plan and the intermediate results. Limits: no mid-run user input, no filesystem or shell from the script itself (agents do that), no `import()`, 16 concurrent agents by default, 1,000 per run, `Date.now()` and `Math.random()` throw so a run can resume. `/workflows` lists runs and can pause or stop them. Workflows are on in every plan; on Pro, turn them on in `/config`. The size guideline defaults to `small` on Pro.

What this repo does today, for comparison:

- ADR 0002: one to two cells at a time, relay handoffs through the board, auto-pause at 90% usage. CLAUDE.md sets `max_concurrent_cells: 2`.
- ADR 0016: the bridge spawns headless `claude -p` stream-json children, tracks a live map, creates worktrees and enforces the concurrency and usage gates itself. **It exists because the user runs from the Claude desktop app and cannot use `claude --bg`.**
- The orchestrator runs the relay turn by turn (qa `specify`, developer, qa `verify`, `risk-check`, optional `security`, PR, merge) and stops at pass gates.

**Decision.**

1. **Agent view is an optional local runtime, not the new default.** Add it as a second `CellRuntime` implementation (ADR 0004's adapter seam) whose spawn is `claude --bg --agent <cell> --name <ref>-<cell>` and whose state read is `claude agents --json`. ADR 0016's `claude -p` adapter stays the default, because the user's desktop-app constraint still holds. The `--bg` adapter turns on only when `DEN_RUNTIME=bg` (or the equivalent in `cells/policy.mjs`) is set and `claude daemon status` answers.
2. **Keep our guards in front of agent view.** The claim lock, `cell-start.mjs` worktree guard, `max_concurrent_cells`, the 90% usage gate and the ADR 0016 consent and spawn-safety rules apply before any `--bg` spawn. Agent view's own worktree and auto-commit behaviour does not replace them. Two clashes need a ticket each:
   - agent view commits and pushes on its own, while cells hand off through `board release` and the orchestrator owns PR and merge. The `--bg` prompt template must say "do not push or open a PR" for non-orchestrator cells.
   - agent view picks its own worktree path and branch, while `cell-start.mjs` names `<cell>/<NN>-<slug>`. Set `worktree.bgIsolation: "none"` for dispatched cells and let `cell-start.mjs` keep owning the checkout, or accept agent view's path and teach the guard about it. A spike decides.
3. **The relay becomes one saved workflow, `.claude/workflows/relay.js`, for a single approved ticket.** It takes `args = { ref }` and runs phases `specify`, `build`, `verify`, `risk`, `security` (only on a hit) with `agent()` calls whose prompts are the same dispatch text the orchestrator writes today, each starting with `cell-start.mjs` and ending with `board release`. The script stops at a pass gate by returning: it never opens the PR or merges, and a user verdict starts a second workflow or an orchestrator session. This respects the "no mid-run input" limit and keeps pass gates and the twice-failed-ticket stop as they are. The orchestrator still opens the PR and merges on green CI.
4. **Do not fan out.** One workflow runs one ticket, one agent at a time per phase. The docs' `parallel()` and `pipeline()` stay unused for relay work. ADR 0002's reason (every active cell re-sends its whole context, and swarms cost several times the tokens) is unchanged; the workflow only moves sequencing out of the orchestrator's context. Pin `workflowSizeGuideline` to `small`.
5. **Use workflows for one new job that fits them:** read-only sweeps, such as the pipeline-retro scan and a repo-wide `risk-check` audit, via `scout`-type agents with a `schema` so results come back as JSON. These are candidates after the relay workflow proves out, not part of the first slice.
6. **Cloud sessions are out of scope for agent view.** Agent view is local-only. `docs/agents/cloud-sessions.md` keeps its current flow (orchestrator plus Agent-tool cells, GitHub MCP for PRs). Workflows may run in the cloud, and the docs say their saved results survive a reclaimed VM, so a spike should check that `relay.js` works there.
7. **Reversible by switches the docs name.** `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` and `CLAUDE_CODE_DISABLE_WORKFLOWS=1` return the repo to today's behaviour. No ticket removes the existing orchestrator path until the user says the workflow beat it.

**Considered options.**

- *Replace the bridge's `claude -p` adapter with `--bg`.* Rejected: it breaks the desktop-app constraint recorded in ADR 0016, and agent view is a research preview whose shortcuts and flags may change.
- *Convert all cell types into workflow agents.* Rejected: cells claim tickets, stop at user gates and write handoffs, which a script with no user input cannot do between stages.
- *Use `ultracode` or `/effort ultracode` for the relay.* Rejected: it plans a workflow for every task and waives the large-workflow warning and the concurrent-subagent limit, which fights the Pro-plan token hygiene in CLAUDE.md.
- *Agent teams.* Not adopted: experimental, disabled by default, and ADR 0002 already measured it at about 7x the tokens.

**Spikes first (each a go or no-go before any build).**

- **S1.** From a clean checkout, does `claude --bg --agent developer "<dispatch prompt>"` honour the genome in `.claude/agents/developer.md`, the tools list and the skill preload?
- **S2.** Does `bgIsolation: "none"` plus `cell-start.mjs` give the same worktree and branch as today, and does the worktree guard let a `--bg` session run `board` commands against the main checkout?
- **S3.** Can the `--bg` prompt reliably stop the session before it commits and pushes?
- **S4.** Does `claude agents --json` expose enough (state, session id, cwd, name, last result) to drive the UI's cell list without transcript tailing?
- **S5.** Does a saved workflow whose agents run `board claim` and `board release` complete a full relay on one ticket, and does `/workflows` pause and resume leave the claim lock consistent?
- **S6.** Token cost of the workflow relay against the orchestrator relay on the same small ticket, from `.scratch/usage.jsonl`.

**Follow-up tickets (to file on the board when this ADR is accepted).**

1. `organism-infra`: spike S1 to S4 (agent view), architect-sized, writes findings to an ADR amendment.
2. `organism-infra`: spike S5 and S6 (relay workflow), then `.claude/workflows/relay.js` with a qa-specified test for its `meta` block and phase titles.
3. `organism-infra`: the `--bg` `CellRuntime` adapter behind `DEN_RUNTIME`, only if S1 to S4 pass.
4. `docs`: update `CLAUDE.md`, `CONTEXT.md` (terms: **Background session**, **Workflow run**) and `docs/agents/cloud-sessions.md`.
5. `security`: review the permission surface. `--bg` sessions and workflow agents run unattended, so ADR 0016 decision 6.10 (a cell editing its own `.claude/` settings) applies to both, and `.claude/workflows/**` should join the `risk-check` patterns.

**Consequences.** Nothing runs differently until a spike passes and the user accepts a follow-up. If all spikes pass, the orchestrator's relay sequencing moves into one script, and local users who can run `claude --bg` get dispatch, attach, peek and stop without bridge code. If S2 or S3 fail, agent view stays a manual convenience for the user and only the workflow half lands.
