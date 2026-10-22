# Agents run behind a wall with grants, the bridge performs every privileged action, and Bao coordinates and merges

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** accepted (user, 2026-10-10, in chat: "ADR0021 looks good"; drafted the same day by a plain session from the agent-system grill, 33 questions answered by the user). It amends ADR 0016 (decision 6's push and PR deny for den-started agents, the ten-minute deny, who holds credentials), ADR 0019 (decision 8, one active feature; decision 9, the testbed) and ADR 0002 (what counts against `max_concurrent_cells`). Spec: `.scratch/agent-os/spec.md`.

**Context.** Den Loop v1 (den-v1/13, PR #214) lets the user start one agent on one ticket from the den. Its first passing live run showed the system is tight in the wrong place and loose in the wrong place:

- A one-line task needed seven approvals, six of them for the agent's own board calls.
- Nothing at the OS level stops a den-started agent writing outside its worktree or using the network. Its limits are permission prompts, four deny rules, an environment allowlist, a cap of two agents and a usage cutoff at 90%.
- The multi-role relay runs only as subagents inside a desktop session, which the den cannot see. The bridge relay of ADR 0016 is not built.

The user's aim: build anything from the den, with every agent its own session, permissions tied to the task, limits on the machine's resources, and governance, "a secure OS with agents". The threat to defend against is agent mistakes and hostile content an agent reads (the web, a dependency, a target repo's own files). A determined attacker on the user's machine is out of scope.

## Decisions

1. **The model.** The bridge is the kernel. An agent is a separate CLI session (a process). Its worktree is the only place it may write. A bridge route is a system call. Role ceilings and task grants are capabilities. Needs you is the prompt for rights beyond them.

2. **The wall.** An agent may read the project and do anything inside its own worktree without asking. Outside the worktree and on the network it is refused or asks. The wall is the CLI's built-in sandbox for filesystem and network, with a `systemd-run` scope for CPU and memory. A spike under the bridge's real spawn flags comes first and ends in a go or no-go; a container per agent is the fallback. Until the spike reports, nothing in this ADR claims the wall holds.

3. **Grants.** A role sets the most an agent of that role can ever do (its ceiling). A task adds named extras, shown to the user at Start. Beyond both, the agent asks in Needs you. Only `claude-adapter.mjs` turns a ceiling and grants into CLI flags or settings. ADR 0016 decision 6 holds: no client string reaches argv or the prompt template.

4. **Network.** None by default. A project names its hosts once (its package registry, its git host) and the user approves that list. A host not on the list asks the user. Only the scout reads the open web; it cannot write code, push or merge, and other agents receive its report as data.

5. **When the wall refuses.** The first refusal shows on the panda's card and in the transcript. After three refusals of the same kind the bridge pauses the agent and asks the user, with "grant for this task" offered. The bridge detects refusals from the stream; no model is involved.

6. **No consumption caps.** No per-agent or per-task cap on tokens, cost or wall time (the user: budgets "backfired"). Consumption is still recorded in the ledger and shown. Whether consumption can be estimated per task accurately is a later research question. The existing plan-level cutoff at 90% usage stays.

7. **Privileged actions go through the bridge.** Board writes (claim, comment, handoff, release), push, PR, merge and starting an agent are bridge calls. The bridge holds the only credentials and checks policy itself before acting. No agent, Bao included, holds git or GitHub credentials. Agents may push their branch and open a PR this way, which replaces the deny rule for den-started agents.

8. **Bao is the coordinator.** The existing orchestrator role, embodied as Bao at the Pass. It runs as short sessions woken by events (a ticket is ready, an agent finished, checks turned green), never as a standing session; state lives on the board. It may split an approved spec into tickets, start and stop agents within policy, and ask for a merge. It has no code-write access and never answers another agent's permission request.

9. **Merge.** The bridge merges on Bao's request only after checking the conditions itself: CI green, qa verify passed, and risk-check clean or security passed. In the target project that is enough. In this repo the merge is refused when the diff touches a guardrail path; those stay with the user.

10. **The user's gates.** Changes to the guardrails themselves (`.claude/`, role ceilings, bridge policy, the adapter, project host lists, the guardrail path list), anything published outside the machine other than a git push, and every request to cross the wall.

11. **Pipeline.** Slim by default: developer test-first, then a light qa verify, each its own session. Bao adds qa specify and security when risk-check hits or the ticket is marked risky. Jev is parked until the bridge relay exists; it then advises that escalation and decides no permission.

12. **Sessions.** At most two working agents at once, plus one reserved slot for Bao and one for a scout (four sessions at most), so a worker that needs a scout can never deadlock. No in-session subagents: a role that needs a scout asks the bridge. The cap is raised later from measurement.

13. **Presence.** The den has an Open/Closed switch, and the user is also treated as away after an idle limit (ten minutes to start, one editable value). When the user is away:
    - An agent waiting on a request writes a handoff and stops. The request is kept for the user's return. This replaces "ten minutes of silence is a deny" (ADR 0016). No pings are sent to keep a cache warm.
    - The freed slot goes to janitorial work: worktree and branch cleanup, board audit and triage drafts, doc fixes, flaky-test repair, and retro.
    - Retro and learning write proposals only (gated patches and tickets). They apply nothing.
    - Bao may merge a janitorial PR only when its diff touches docs and test files alone, with CI green and risk-check clean. Everything else waits.

14. **Projects.** The den works on one target project at a time, in its own directory, chosen when the bridge starts. This repo is the control plane: role files and settings live here and the target repo's own `.claude/` is not loaded. The board lives in the target repo. First target: `safety-aware-route-planner`; then `family-bingo`.

15. **Order.** (1) wall spike, (2) grants, (3) target project, (4) privileged actions through the bridge, (5) bridge relay, (6) Bao with merge, (7) presence and janitorial work, (8) retro proposals. Tickets are written for steps 1 to 3 only. Steps 4 to 8 are reordered and ticketed from what the target project shows.

## Proposed, not yet put to the user

- **Role ceilings.** scout: read the project and the web, no write. developer and qa: write in the worktree, the project's hosts. security: read, and write its report in the worktree. Bao: read the project and board, bridge calls only. designer, architect, product and herald: not worked out.
- **Guardrail paths in this repo.** `.claude/`, `apps/bridge/cells/policy.mjs`, `apps/bridge/cells/claude-adapter.mjs`, wherever ceilings and host lists are stored, `.github/workflows/`, and the path list itself.
- **UI.** Grants at Start, wall notices, the Open/Closed sign and Bao's body need a design session with mockups before any code.

## Task tree with a barrier (the user's idea; decided 2026-10-10 in a second round, questions 34 to 37)

16. **A large task is a tree, and the bridge holds its barrier.** A higher model cuts a large task into scopes small enough for the smallest model. A swarm of small-model agents takes one scope each. Each signals completion to its parent. The parent proceeds only when all its children are done, runs the risk checks and sends the result to Bao for evaluation.
    - **Barrier.** A bridge object: a parent ticket blocked by its child tickets. The bridge wakes the parent when the last child is done. No parent session waits.
    - **Swarm size (amends decision 12).** A separate lane of up to four small-model workers, alongside the two larger workers and the reserved slots. Raised later from measurement.
    - **Sign-off (amends decision 9 for trees).** The user approves the plan (the cut into scopes) before the swarm starts, and the feature PR at the end. In between, the bridge merges a child's branch into the parent's branch on green checks. Decision 9 still governs a ticket that was not cut into scopes, and decision 13 the janitorial PRs. *(That last sentence is the drafting session's reading, not a quoted answer.)*
    - **A child that fails or stalls.** One retry with a sharper brief, then a larger model takes that scope, then the user is asked. The barrier has a limit and never waits forever.
    - The slim pipeline of decision 11 is this tree with one child. Step 5 builds the relay with a barrier, starting at depth one.
    - Not known, to be measured on the target project: whether a higher model can cut scopes the smallest model finishes without bouncing; what each extra session costs to start (the three unfinished den runs used 23k to 26k tokens each); how children's branches are integrated without conflicts.

## Unknown until the spike

1. Whether the CLI sandbox starts under the bridge's spawn flags on WSL2.
2. Whether a write outside the worktree is blocked by the OS, not only prompted.
3. Whether the network is blocked except for named hosts.
4. Whether commands inside the wall run with no prompt.
5. Whether `systemd-run` memory and CPU limits apply to the agent and its children.
6. What the Read, Write and Edit tools do outside the worktree. The sandbox is believed to cover shell commands only, so these may still need permission rules.
7. Whether a sandbox refusal can be told apart from an ordinary failed command in the stream (decision 5 depends on it).

Also not known: how roles load when the agent's working directory is another repo (decision 14), and how long a bridge-run agent's prompt cache lives.

## Amendment 1 (accepted by the user 2026-10-10, question tool: "Go, accept the amendment"): what the wall spike found

The spike is agent-os/01. It ran the real CLI (2.1.293, Haiku) three times on WSL2 with the bridge's own argv and the wall on, in a worktree of a throwaway repository. The third run is recorded in `apps/bridge/cells/fixtures/wall.jsonl`, with the disk state the harness found in `wall-results.json`. `node apps/bridge/cells/conformance.mjs --spike Wall` runs it again.

**The settings that produced it.** The argv is the bridge's unchanged. The inline `--settings` value gains one block, built by `buildClaudeArgs({ wall: { hosts } })` in `claude-adapter.mjs`:

```json
"sandbox": {
  "enabled": true,
  "failIfUnavailable": true,
  "allowUnsandboxedCommands": false,
  "autoAllowBashIfSandboxed": true,
  "network": { "allowedDomains": ["example.com"], "strictAllowlist": true }
}
```

The production runtime does not pass `wall` yet. That is agent-os/02.

**Answers to the seven unknowns.**

1. **Does the sandbox start under the bridge's flags on WSL2? Yes.** `bwrap` and `socat` were enough. With `failIfUnavailable` on, the child started and its commands ran inside the sandbox.
2. **Is a write outside the worktree blocked by the OS? Yes, with one opening.** A shell write to the repository root and to the home directory failed with `Read-only file system` and no file appeared. The `dangerouslyDisableSandbox` parameter was passed and changed nothing. The opening: the main checkout's `.git` directory is writable from a worktree (the CLI allows it so that `git commit` works); a write to `.git/hooks` was refused, and the CLI's documentation says `.git/config` is refused too (not tried).
3. **Is the network blocked except for named hosts? Yes.** The listed host answered. The unlisted host was refused by the sandbox proxy with no request raised. A sandboxed command sees only the loopback interface, and a direct TCP connection failed with `Network is unreachable`.
4. **Do commands inside the wall run with no prompt? Mostly.** Twelve of thirteen sandboxed shell commands raised no request. One did (`curl` with a `-w '%{http_code}'` argument, "This command requires approval"): the CLI still asks about some command shapes, whatever the sandbox.
5. **Do `systemd-run` limits apply? Yes** (run later the same day, once the user had enabled linger; fixture `limits.jsonl`, spike `Limits`). The CLI was started as `systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 -p OOMPolicy=continue -p CPUQuota=100% -- claude …`, with the wall on. A sandboxed command reported the scope as its own control group. A command that asked for 3 GB was killed (exit 137, `oom_kill` rose by one in the scope) and the agent went on to the next turn. Four busy loops for four seconds were throttled to about one core (4.5 s of CPU in a 6.9 s turn that asked for 16). Three things to know:
   - It needs a user service manager. This machine had none until `sudo loginctl enable-linger <user>` was run.
   - With systemd's default `OOMPolicy` (stop), the first run ended the whole scope, agent included, as soon as one command went over the memory limit. `OOMPolicy=continue` kills only the process the kernel picks.
   - `systemd-run --user` needs `XDG_RUNTIME_DIR` to find the user bus. The bridge's child environment does not carry it, so the launcher sets it for `systemd-run` and removes it again for the CLI.
6. **What do Read, Write and Edit do outside the worktree? They ask.** Each raised a request ("Path is outside allowed working directories"). They are not behind the sandbox: the one outside Write that the harness allowed was written. Inside the worktree, Read ran unasked and Write still raised a request.
   - *Note (hardening/01, 2026-10-22):* superseded. The CLI still raises the request, but the bridge's host now answers it: a Read, Write, Edit or NotebookEdit on a path outside the agent's worktree gets a deny with a reason, at once, and never becomes a question for the user. Paths are resolved lexically (relative ones against the worktree, `..` folded) and compared on a segment boundary; a request with no usable path is denied too. Exceptions: a Read of the agent's own ticket file, and a path the user granted. Everything else is answered as before (a connection's tools from the library catalog, Bash and WebFetch asked). We first tried `permissions.defaultMode: "dontAsk"` in the inline settings and dropped it: it refuses every tool no allow rule names, which would have changed the answers for tools this decision did not mean to touch. The rule is `fileToolRefusal` in `claude-adapter.mjs`, applied in the host's `permission-request` branch and by the Wall spike harness. Question 6 of the spike now asks whether the outside calls raised a request, were denied by the host, errored and left the disk untouched; the live re-run is the user's.
7. **Can a refusal be told apart in the stream? Partly.** A refused host carries a `<sandbox_violations>` block and an `X-Proxy-Error: blocked-by-allowlist` header in the tool result. A refused write has no mark: it is an ordinary failed command whose text says `Read-only file system`. No separate line kind reports either.

**What this changes for the steps that follow.**

- The wall covers shell commands only. The file tools, hooks and MCP servers stay outside it. For the file tools, permission rules are the boundary, so decision 3's "refused outside the worktree" is "asked about" for Read, Write and Edit unless agent-os/02 adds deny rules.
- Decision 3's "free inside the worktree" needs an allow rule for Write and Edit in the worktree. The sandbox does not give it.
- Reads are open. A sandboxed command read a file in the repository root and one in the home directory, unasked. With any host on the list, a file the user can read could be sent there. agent-os/02 should try the CLI's read limits (`sandbox.filesystem.denyRead` with `allowRead`, or `permissions.blockReadsOutsideWorkingDirectories`) before a host is listed for an agent that handles hostile content.
- An agent can write to the main checkout's `.git` (a new file there was written; a file under `hooks` was refused). The bridge should not trust a branch in the main checkout that an agent could have moved.
- Decision 5 (notice, pause at three of a kind) can be built on the tool result text: the violations block for hosts, and `Read-only file system` for writes. The second is a text match and can be wrong.
- Decision 2's hardware limits work as a scope around the CLI. Where the `systemd-run` argv lives (it is not a Claude flag), the limit values per role, and whether an agent that goes over memory is stopped or only loses the command, are for agent-os/02.

## Amendment 2 (proposed by the architect for agent-os/07 on 2026-10-11, pending the user's acceptance): the rule for the main checkout's `.git`

**What was found.** A developer child in a worktree wrote the main checkout's `.git/refs` and `.git/HEAD`, and `git update-ref` and `git branch` succeeded (`.scratch/agent-os/handoffs/07-developer.md`). Amendment 1 named the opening and left it for the bridge to distrust; this closes it.

**The cause, from the code and the CLI binary (2.1.293).**

- When the working directory is a linked worktree, the CLI adds the worktree's git common directory (the main checkout's `.git`) to the sandbox's write allowances, so that `git commit` works. It then denies a short fixed list inside it: `hooks`, `config`, `config.worktree`, `commondir`, `objects/info/alternates`, and the same `config.worktree` and `commondir` under each `worktrees/<name>`. `refs`, `HEAD`, `packed-refs` and `index` are not on that list.
- The adapter adds nothing for them. `sandboxFor` builds `denyWrite` from the governed list resolved against the worktree (`<worktree>/.git`) plus `denyAbs`, and `denyAbs` is built only from the path grants (`governedUnder`). `host.mjs` passes `root` only when a task has grants. So a task with no grants has no deny on the main `.git`.
- The developer's guess is therefore half right. Passing `root` for every task is not enough: even with `root` and a grant elsewhere, `denyAbs` holds only the governed paths that grant reaches, never `<root>/.git/refs`.

**What the sandbox can and cannot say (live prototype, real child, bridge flags, production path).**

- A `denyWrite` on an existing file or directory under the allowed `.git` holds: `Read-only file system` for a shell write, for `git update-ref`, `git branch` and `git tag` (git cannot create the `.lock`), and for a `HEAD` rewrite.
- A `denyWrite` on a path that does not exist is masked so that it cannot be read: with `packed-refs` absent, every git command in the worktree failed with `couldn't read .git/packed-refs: Permission denied`. Every deny target must exist before the spawn.
- A deny cannot be narrowed by a more specific allow. With `refs` denied and `refs/heads/den/feat` allowed, the agent's own `git commit` failed: `Unable to create '.git/refs/heads/<its branch>.lock': Read-only file system`. The sandbox cannot say "deny the other refs, keep my own branch".
- A worktree on a detached `HEAD` commits without touching any ref: with `refs`, `HEAD` and `packed-refs` denied, `git commit` succeeded (objects and the worktree's own `HEAD` and index), and every ref write, including `refs/heads/main`, a new branch and a tag, was refused.

**The rule (decision 17).**

17. **A worktree agent commits detached and cannot write refs.** The bridge creates each agent's worktree on a detached `HEAD` at the base commit (`git worktree add --detach`), not on a new branch. The agent keeps `objects` and its own `worktrees/<name>` entry (commit, add, status, diff, log all work). The sandbox denies, in the main checkout's `.git`: `refs`, `HEAD`, `packed-refs` and `index`, on top of the CLI's own list (`hooks`, `config`, ...). The Write and Edit tools get the same denies through `denyAbs`. The deny targets are fixed names built from the main checkout's path; they come from no grant and no client string. The branch name stays as before (`den/<ref>-<id>`), but it is the name the bridge will use: the bridge, which holds the credentials (decision 7), creates the branch at the agent's final commit and pushes it when the agent is done. If a deny target does not exist at spawn, the bridge makes it exist (`git pack-refs --all --no-prune` creates `packed-refs`) or refuses the spawn; it never spawns with a deny missing.
    - **What stays open.** `worktrees/<other>` (a sibling agent's `HEAD` and index), `logs`, `info` and `objects` are writable. A sibling's `HEAD` is moved, not a ref the bridge trusts. Denying siblings that exist at spawn is a best-effort addition, not required for this ticket.
    - **If the user will not detach.** The fallback inside the sandbox is: keep the named branch and deny `HEAD`, `packed-refs`, `index`, `refs/tags`, `refs/remotes` and `refs/stash` (each must exist). `refs/heads` stays writable, so an agent can move or create any branch, `main` included. The bridge then treats every branch as untrusted (Amendment 1) and takes the sha from the worktree's `HEAD`, not from a ref. The stronger fallback is decision 2's container per agent.
    - **Always-on.** The denies apply to every task that spawns in a worktree, with or without grants. They are keyed on a new compile option for the main `.git` path, separate from `root`, so a task without grants gets them and the agent-os/02 grant rules keep their meaning.

## Amendment 3 (proposed by the architect for agent-os/03 on 2026-10-11, pending the user's acceptance): running a task on another repo

Answers the two unknowns of agent-os/03: how a role loads when the agent's working directory is another repo (decision 14, "Also not known" above), and where the board sits and how the bridge finds it.

**What was found (live prototype, real CLI 2.1.293, Haiku, a throwaway target repo holding hostile content, the child started in a worktree of it under `.claude/worktrees/`).** The target had a `SessionStart` hook that creates a file, a same-named role `probe` and an extra role `evil`, a skill `evil`, a `CLAUDE.md`, and an `.mcp.json`. The control directory had its own `probe` role and a skill.

| Flags | Result |
|---|---|
| The bridge's today: `--setting-sources project,local --agent probe` | **Everything of the target loaded.** The hook fired, `evil` role and skill were listed, the target's `probe` replaced ours (the reply carried the target role's token), and the target's `CLAUDE.md` was in context (found by walking up from the worktree). |
| `--setting-sources ""` alone | The hook, target roles, skills and `CLAUDE.md` are gone, and `--agent probe` fails: `not found`. The role has to come from somewhere else. |
| `--setting-sources ""` plus `--agents '{"probe":{...}}'` | Clean: no hook, no target role, skill or `CLAUDE.md`; our role text was used. Inline roles carry no skills. |
| `--setting-sources ""` plus `--add-dir <control>` | Skills did not load. It would also give the agent write access to the control checkout. Rejected. |
| `--setting-sources ""` plus `--plugin-dir <control>/.claude` (a `.claude-plugin/plugin.json` there), `--agent den:probe` | **Clean, and complete.** The role loads as `den:probe` and the skills as `den:<name>`; nothing of the target loaded. |

Not shown: that a genome's `skills:` preload works under the plugin namespace. A bare name (`organism-protocol`) and a prefixed one (`den:organism-protocol`) both left the skill listed but not preloaded. The skills are reachable through the Skill tool, so the prompt names them. The real genomes (`tools: Agent(scout)`, `isolation`, `maxTurns`) were not run as plugin roles; the first test must.

**Decision 18. Roles and settings come from this repo, and the target's `.claude/` and `CLAUDE.md` are never loaded.**
- The bridge starts every child with `--setting-sources ""` and `--plugin-dir <control>/.claude`, and the role is `den:<role>` (`--agent den:<role>`). `<control>` is this repo's checkout, taken from the bridge module's own location, never from a working directory or a client string. `--strict-mcp-config` stays, so the target's `.mcp.json` is ignored.
- This repo gains `.claude/.claude-plugin/plugin.json` (`{"name":"den","version":"0.0.1"}`). It is under `.claude/`, so it ships as a gated patch for the user.
- One rule for every target, this repo included. A den task on this repo no longer loads `.claude/settings.json` (its hooks and its allow rules such as `Bash(npm run board:*)`). The wall and the inline settings are the boundary (decision 1), and board calls ask until step 4. This is the cost of one rule instead of two paths.
- The prompt template stops saying "Read `.claude/agents/<role>.md`": in a target worktree that path is the target's own file, which is the hostile route, or is absent. The template names the skill to invoke (`den:organism-protocol`) instead.
- The target's `CLAUDE.md` is data, not instructions: the agent may Read it, nothing loads it. Task context for a target belongs in the ticket. This costs the agent the project's own conventions until the user decides otherwise.
- The adapter stays the only place flags are built (decision 3). `buildClaudeArgs` gains a `control` option (a plain absolute path), checked like `worktree`.

**Decision 19. The board is the target's `.scratch/`, and the bridge's root is the target.**
- The layout is unchanged: `<target>/.scratch/<feature>/issues`, and the ledger, `sessions.jsonl`, usage, events and requests beside it. The board service already takes a root, so nothing in it changes. The bridge finds the board because it was started against the target: `root` is the target's path.
- `.scratch/` must not show up in the target's `git status`. At start the bridge appends `.scratch/` to `<target>/.git/info/exclude` if it is missing. No tracked file of the target changes. (`info` is writable by an agent, per Amendment 2; the worst case is untracked noise.)
- The agent's board CLI is not `npm run board`: a Python target has no `package.json`. The prompt names `node <control>/apps/organism-infra/board.mjs`, built by the bridge from its own location. Run in the target's worktree it already resolves the target's main checkout (`resolveRoot` takes the first entry of `git worktree list`), so no variable is passed. These writes are outside the wall and raise requests, as the ticket says, until step 4.
- The ticket file the agent may Read (the one allow in the inline settings) is the target's, under `root`. No change.

**Decision 20. Two roots.**
- `control` is this repo (bridge code, `governance.json`, role files, project host lists). `root` is the target, defaulting to `control`, so a bridge started as today behaves as today.
- Worktrees, `den/` branches, `prepareMainGit` and the Amendment 2 denies all key on `root`, so they work unchanged on the target's `.git`. The target's checked-out `HEAD` is the base; uncommitted changes in it are not in the worktree.
- The governance denies are paths relative to the worktree, so they apply to the target too: an agent cannot write the target's `.claude/` or `.github/workflows/`.
- **The bridge takes the target at start and refuses before listening** when the target is not a git repository (`git rev-parse --show-toplevel` is not the path), when its `.git` is not a directory (a linked worktree or submodule), or when its path is not plain. Plain means the set `isWorktreePath` accepts. The same check runs on `control` and `$HOME`.

**Decision 21. A project's host list is one file in this repo.**
- `apps/bridge/cells/projects.json`: `{ "<slug>": { "hosts": ["pypi.org", ...] } }`. The slug is given at start with the target. Every host passes `isWallHost`. The bridge reads it at start; no agent can reach it. The file joins `governance.json`'s guardrail paths, so changing it is the user's gate (decision 10), and a project with no entry gets no hosts. This is consumed by agent-os/02's grants; this ticket adds the file and the lookup only.

**What this closes from agent-os/11.** A target at a path with a space would have refused every spawn with a 502 (the `mainGit` rule fails closed). The start check refuses once, with the reason, instead. Because `root`, `control` and `$HOME` are checked at start, `root` and `home` can no longer be dropped silently by the runtime. Security's low finding (an `undefined` `mainGit` still spawns without the denies) becomes live now that callers are added: the runtime should throw when `cwd` is a worktree and `mainGit` is missing.

**Consequences.**
- The first live target is not on this machine: `safety-aware-route-planner` has to be cloned (plain path) before the live run. Whether its Python tooling runs inside the wall (package hosts, a virtualenv outside the worktree) is unknown and is the friction the live run is for.
- A role that needs a skill's text at start (the `skills:` preload) gets it by the prompt naming it, one tool call later, until a preload under a plugin namespace is shown to work.
- Step 4 (board calls through the bridge) removes the `board.mjs` path from the prompt and the requests it raises.

**Status of Amendment 3:** accepted in part by Amendment 4 (decision 18 for other projects only, decision 20 with the project chosen in the den); decision 19 replaced; decision 21 deferred.

## Amendment 4 (decided by the user 2026-10-15, question tool, in the outcome 6 grilling): the den works for other projects

The den-mvp spec's outcome 6 ("one real change in the routing project, from the den") settled what Amendment 3 left open. Spec: `.scratch/den-mvp/outcome-6-spec.md`.

**The model (the user's words).** "The den is its own organization that you can imagine is contracted out to do development for these other projects." Dim Sum Dev is its own product and its own project. An onboarded project has its own repo, its own tickets, board and queue, and all of it is reached and dispatched from the den's interface. What the den brings to every project is its way of working: the guardrails, the sandbox, and how work is passed around efficiently and safely.

- **Decision 18 applies to other projects; the den's own runs start as today.** A run on another project starts with `--setting-sources ""` and `--plugin-dir <control>/.claude`, as `den:<role>`. Nothing of that project's `.claude/` loads: no hooks, roles, skills or settings. A run on the den's own repo keeps `--setting-sources project,local`, its own roles and `CLAUDE.md`, with hooks already off (`disableAllHooks`, den-mvp/03). The bridge picks the path by whether the project is the control project; an agent can't choose it.
- **A project's own instructions are passed in by the bridge.** The bridge reads the project's `CLAUDE.md` or `AGENTS.md` from its main checkout's committed `HEAD`, never from the agent-editable worktree, and adds it to the run as project knowledge. Its `CONTEXT.md` and ADRs stay files the agent reads.
- **Decision 20 is accepted, with the project chosen in the den, not at bridge start.**
  - Projects are onboarded at setup: a path and a slug, checked like decision 20's start check.
  - The den lists every onboarded project, and its board and queue can be opened, with tickets added or approved, at any time.
  - Runs and deliveries happen only in the **active project**. The bridge refuses a switch while a run of the active project is running.
  - `control` stays this repo, from the bridge module's location. This also replaces decision 14's "chosen when the bridge starts".
- **Decision 19 is replaced: a target's board is its own tracker.** For `safety-aware-route-planner` that is its GitHub Issues, where its `docs/agents/issue-tracker.md` already puts tickets. The bridge reads and writes them with the git-host login it holds; no agent gets the token. A claim is a `den:in-progress` label plus a comment naming the run; removing the label releases it. The den's own board stays the markdown board in `.scratch/`.
- **Decision 21 is deferred.** Runs on a target get no network. Its toolchain (compilers, a Python virtualenv, `node_modules`) is installed once at setup outside the wall and mounted read-only. A changed requirements file is a setup step for the user. A host list returns when a project needs network.
- **Delivery on a target** follows ADR 0024 and merges on green GitHub checks. The den's own local checks (den-mvp/34) stay den-only. Setup turns on branch protection on the target's `main` (`test.yml` and `lint.yml` required), so GitHub enforces the merge rule the bridge follows.

**Consequences.**
- A board adapter: the bridge's board operations (list, read, claim, comment, resolve, create) get a GitHub Issues implementation beside the markdown one, chosen per project.
- The adapter's clean start (decision 18) touches only runs on other projects. Its first test is the real genomes as plugin roles; a genome's `skills:` preload under the plugin is unshown (Amendment 3), so the prompt names the skills until it is.
- Two start paths exist, chosen by the bridge. A change to one is checked against the other in review.
- Ticket states the den uses (`ready-for-human`, `ready-for-agent`, resolved) map onto the target's issues: labels for the first two, closing the issue for the last.

## Amendment 5 (proposed by the architect for den-mvp/47 on 2026-10-16, pending the user's acceptance): worktrees, the project registry, the queue, and the seam between `control` and the active project

Answers the three points Amendment 4 left open, and says where the seam goes. Slices: den-mvp/48 to 54; spec `.scratch/den-mvp/outcome-6-spec.md`. Code read: `cells/workspace.mjs`, `cells/host.mjs` (root-keyed state), `delivery/git-host.mjs`, `delivery/board.mjs`, `snapshot.mjs`, `server.mjs` (start-up).

**What the code does today.** `startBridge({ root })` takes one root and closes over it: `createHost({ root })` builds the sessions, conversations, workspaces, ledger and ticket-file path from it; the hub, the delivery board, the git host, the meeting store and the request log do the same. Workspaces already take only a `root` (`createWorkspaces(root)`, `prepareMainGit(root)`, `createGitHost(root)`), so those modules need no change; what is missing is something that picks the root per run. `stateDir` is already `<denState>/projects/<hash of root>`.

### Decision 22. A target's worktrees live under `<target>/.claude/worktrees/`

Options:
- **Under the target (chosen).** Same `WORKTREES_DIR` as the den's own, so `workspaceNames`, `reopen` (repo-relative names in run records), `scripts/worktree-gc.mjs --root <target>` and the plain-path check work unchanged. The cost is one untracked directory in the user's clone. The bridge appends `.claude/worktrees/` to `<target>/.git/info/exclude` when it is missing (at onboarding and at each activation), the way it already adds `.den/`. No tracked file of the target changes. The target's `.gitignore` is never edited; if the target tracks anything under that path, onboarding refuses with the reason.
- **In the den's state** (`<denState>/projects/<slug>/worktrees/`). Keeps the target's tree untouched, but the state folder also holds the releases, the credentials and the delivery logs, so the wall would need a carve-out in a folder it must otherwise deny. It also changes `workspaceNames`, run records and the gc script from repo-relative to absolute for one project. Rejected.

The CLI finds no project settings while walking up from `<target>/.claude/worktrees/x`, because a target run starts with `--setting-sources ""` (Amendment 3 prototype, which ran in exactly this layout).

### Decision 23. The registry is a file in the den's state, written only by the user's terminal

Options:
- **`<denState>/projects.json` (chosen).** Machine-specific paths and toolchain mounts do not belong in git, and the den runs from release folders, so a repo file would need a release and a restart to onboard a project. The shape is `{ "<slug>": { "path": "/abs/plain/path", "board": { "kind": "github-issues", "repo": "owner/repo" }, "toolchain": ["/abs/path", ...] } }`. `den` is the control project's slug and is implicit (path = `control`, board = the markdown board); a stored `den` is refused. A slug passes `^[a-z0-9][a-z0-9-]{0,31}$`. `toolchain` is the list of read-only mounts den-mvp/52 consumes. The bridge reads the file and never writes it; `npm run den:project -- add|list|remove` (the user's terminal, setup) is the writer, through the same validation (a git repo, a real `.git` directory, a plain path, `origin` and `main` exist, the exclude line is added). The bridge re-reads it when its mtime changes, so onboarding needs no restart, and checks the path again at activation and at each run start.
- **A guardrail file in the repo** (`apps/bridge/cells/projects.json`, the shape Amendment 3 decision 21 used for host lists). Gives the merge gate for free, but fails the two reasons above. The gate comes instead from the wall: an agent writes only its worktree (the ceilings), and `~/.local/state/den/projects.json` joins `governance.json`'s `credentialPaths`, so no grant can reach it and it is not readable.
- The **active** project is a separate one-line file, `<denState>/active-project`, written by the bridge on a switch. The registry has one writer (the user) and this file has one (the bridge). It is read at start; a missing or unregistered slug means `den`. A bridge restart by `den:update` therefore does not change the user's context.

### Decision 24. A project's queue is the den's queue scoped to the project; the board kind is an adapter

Options:
- **One queue, one board interface, an adapter per kind (chosen).** The frontier, gate, priority order and `blockedBy` logic in `snapshot.mjs` stay the only queue implementation. A board adapter returns normalized tickets (`ref`, `title`, `type`, `status`, `priority`, `blockedBy`, `holder`) and carries the board operations (`list`, `read`, `create`, `claim`, `comment`, `release`, `resolve`). The markdown board becomes the first adapter (`createDeliveryBoard` and `board-service.mjs` behind it, behaviour unchanged); `github-issues` is the second (den-mvp/51). The frontier is computed from the tickets by the same function, so the UI, dispatch, capacity and delivery see one shape.
- **The target's `den:*` labels read as the queue.** This is what the GitHub adapter does underneath, but as a separate queue it would give dispatch, the kanban and delivery a second frontier code path and lose `blockedBy` and holder. Rejected as an implementation; kept as the adapter's status mapping.

The GitHub mapping, fixed here so den-mvp/51 starts from it:
- **The den's board is the issues that carry a `den:*` label.** Other issues are not tickets and never enter the queue; Bao reads them separately (den-mvp/53). Resolved is a closed issue with a den label.
- **Status:** `den:ready-for-human`, `den:ready-for-agent`; `den:in-progress` is a claim and is added with a comment that starts with a marker line (`<!-- den-claim role=<role> run=<id> -->`), from which the holder is read. The bridge is the only writer and serializes claims in-process; that, not the label, is the exactly-one-holder guarantee.
- **Ref:** `<project-slug>/<NN>-<title-slug>`, `NN` the issue number zero-padded to two digits, so `REF_RE`, branch names and worktree names hold. The number is the key; the slug is derived from the title when a ticket is read.
- **`blockedBy`:** a `Blocked by: #12, #13` line in the issue body; an issue without one is unblocked. **Priority:** a `priority:P1`..`P3` label, default `P2`. These are the only conventions the first target needs.
- **Reading a non-active project** is on demand with a short cache; only the active project is polled for the hub. The interval is den-mvp/51's, bounded by the host's rate limit.

### The seam: the project is resolved once per run, and the run carries it

Options:
- **Make `root` a getter and re-point it on a switch.** Touches every closure and leaves in-flight state (a delivery, a reopened worktree) pointing at the wrong repo after a switch. Rejected.
- **A full service set per project** (`startBridge`'s body per project). Clean isolation, but capacity (`max_concurrent_cells`), the resource-group slice, the approvals queue, Bao's desk, the ledger and usage are shared by the whole den. Each project would need escape hatches to singletons, and two agent tables would break the cell cap. Rejected.
- **One host, a project resolved when a run starts, stored on the run (chosen).** Everything after dispatch (worktree, branch, publish, reopen, `mainGit`, grants root, delivery steps) reads the run's own project, so a switch cannot re-point work in flight.

The module is a new deep one, `apps/bridge/projects.mjs`, with a small interface:
- `createProjects({ control, denState, exec })` where `control` is the bridge module's own location.
- `list()`, then `[{ slug, path, kind, control, active }]`; `active()`; `activate(slug, { runs })`, then `{ ok }` or `{ refused, blocking: [{ id, role, ref }] }`.
- `get(slug)`, then the project handle `{ slug, root, control, board, git, workspaces, toolchain }`, built once per root and revalidated by the start check. `root` is a plain real path. `board`, `git` and `workspaces` are `createDeliveryBoard`-shaped adapters, `createGitHost(root)` and `createWorkspaces(root)`.

Rules, so the callers agree:
1. **`control` and the active `root` are two values; nothing else reads a bare `root`.** `control` is this repo from the module's location and is used for: the role files and `--plugin-dir`, `governance.json`, the den's build, releases and go-live, the checks (den-only, den-mvp/34), the CI watch, the library, meetings, Bao's desk and orchestrator conversations, the ledger, usage, events, the request log and the sessions/conversations store (rows gain a `project` field; rows without one are `den`). The active `root` is used for exactly: the worktree and its branch, `prepareMainGit`, the grants root, the git host and the delivery board of a delivery, and the ticket text.
2. **`createHost` takes `projects` instead of `root`.** `createHost({ root })` stays as a shorthand that builds a control-only `projects`, so existing host tests do not change. A new run takes `projects.get(projects.active())` at the one place `start` creates the workspace, records `agent.project = slug`, and uses that handle for the rest of its life. A client never names a project for a run; the picker (activate) is the only way.
3. **Delivery jobs carry `project`.** The one delivery instance resolves `{ board, git }` by the job's project. The job log stays in the control's `stateDir`.
4. **A switch is blocked by the active project's runs that are not ended.** Bao's desk, meeting and orchestrator runs are `control` runs that touch no project's tree, so they never block a switch, and a target's runs never block the den's own. The refusal names `[{ id, role, ref }]`.
5. **Bao works on a target through material the bridge hands it,** not through a read grant on the target (den-mvp/53): the plan files read from the target's committed `HEAD` (as `CLAUDE.md` is, Amendment 4) and its open issues, in the prompt.
6. **A target run has no ticket file.** The bridge writes the issue text to `<worktree>/.den/ticket.md` (a new note name beside `findings.md` and `meeting.md`, already excluded) and puts it in the prompt; the single allowed Read of the ticket file stays for the den's own runs. No `.scratch/` is created in a target, which makes Amendment 3 decision 19's `.scratch/` exclude line unnecessary.
7. **A target run makes no board call.** The bridge claims on dispatch, comments the outcome and resolves on merge; the agent has no board CLI there (there is no `package.json` to hold one).
8. **The scripted risk check fails safe for a target.** `createGitHost` looks for `scripts/risk-check.mjs` in the repo it is given and reviews every change when it is missing. A target has none, so security reviews every change. The den's script is not borrowed, because its path rules (`apps|packages|scripts/`, the den's guardrail files) would pass a repo with other layouts as clean. **Accepted by the user on 2026-10-16:** every target change gets a security review until a per-project risk rule exists (a registry field, a later ticket).

**Tests at the seam.** `projects.mjs` is tested through its interface with temp git repos and a temp state folder: registration refusals, the persisted active slug, a switch blocked by a named run and allowed without one. Host tests assert that a run started under project A keeps A's root for its worktree, `mainGit` and branch after the active project changes to B. Workspace and git-host tests are unchanged.

**What this changes in earlier text.** Decision 19's `.scratch/` exclude and its `board.mjs` path do not apply to a target (Amendment 4 replaced 19; rules 6 and 7 close the leftovers). Decision 20's start check now runs at registration, activation and run start.

## Amendment 6 (decided by the user 2026-10-18, question tool, in the kernel review): any way out brings the read limit, and the whole den has one bound

**Read limit.** A remote connection reaches the network outside the wall (ADR 0025), so it now brings the read limit as a host does. Before, a run with a connection and no host could read all of home but the credential stores. The limit closes `~/` to the shell and reopens the worktree, the project's `node_modules` and main `.git`, the Node install, `~/.gitconfig` and the Playwright browsers; a reopened path that reaches a credential store refuses the run. The user chose this over a wider denylist and over taking connections from the roles that write. Live Haiku probe (developer, `--settings` from `compileCeiling`, detached worktree): node, npm, a test file, a detached commit and the browsers worked; `~/.bashrc`, `~/context` and `~/.ssh` were hidden. Reopening the project root itself left the worktree read-only, so the root is never reopened.

**The den's bound.** `den.slice` (written by `den:install`) caps the bridge and every group it starts at 75% of RAM: the groups' own limits add up to 12 GiB, more than the 7 GiB machine. Runs raise their OOM score to 500 at the start gate, so a kill in the slice takes a run before the bridge (100). `den.service` gains `NoNewPrivileges`, `RestrictSUIDSGID` and `LockPersonality`, which the agents inherit; nested scopes and bwrap still start under them.

## Consequences

- den-v1/14 (allowlist, then auto mode) is replaced by the wall spike. Auto mode is not adopted: inside the wall no decision is needed, and crossing it reaches the user, not a classifier.
- organism-infra/131 and 155 (sandbox design), 86 (merge on green), 153, 154, 163, 216, 133 and den-scene-v1/13 are covered by this ADR's steps and close as superseded when their step is ticketed.
- 29 tickets of tooling for the desktop relay were parked on 2026-10-10.
- Role files lose the in-session scout. That is a change under `.claude/` and ships as a gated patch for the user.
- The bridge gains the only write path to git remotes. Its own checks (decision 9) become the most security-sensitive code in the repo and need the full relay with security review.
