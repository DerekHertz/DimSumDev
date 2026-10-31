# Den factory: internal audit (2026-10-30)

Read-only audit of the Dim Sum Dev repo at `d478a224` (main, after PR #443), to ground a planning meeting. Every claim cites a path; line numbers are given where they were checked. Counts come from `git ls-files`, `wc -l` and `git log` on 2026-10-30.

## 1. Architecture as it is

### Components

| Component | Path | What it is |
|---|---|---|
| Bridge | `apps/bridge/server.mjs` (1,293 lines) + `routes.mjs` | Node HTTP server: serves the UI, board snapshot (`GET /state`, `server.mjs:541`), and every mutating action behind a token (`routes.mjs:10-59`). It is the "kernel" that starts agents (ADR 0021). |
| Agent host | `apps/bridge/agents/host.mjs` (1,563 lines) | Owns live runs: admission, capacity, approvals, conversations; calls `runtime.spawn` (`host.mjs:847`). Refuses past the cap with 429 (`host.mjs:426`). |
| Runtimes | `apps/bridge/agents/claude-runtime.mjs`, `codex-runtime.mjs`, `container.mjs` | Claude Code CLI and Codex app-server adapters; a container launcher behind `DEN_AGENT_CONTAINERS=1` (`container.mjs:161`, Docker spawn at `:216`). |
| Wall and limits | `agents/ceilings.json`, `agents/governance.json`, `agents/resource-group.mjs`, `agents/limits.json` | Per-role ceilings compiled into sandbox rules; bwrap plus a systemd scope or cgroup per run. |
| Board | `apps/board/board.mjs`, `board-service.mjs`; `apps/bridge/board/{markdown-board,github-issues,project-boards}.mjs` | Markdown tickets under `.scratch/` with lock-file claims (ADR 0003, 0008); a GitHub Issues adapter behind one `Board` interface (ADR 0021 Amendment 7, decision 25). |
| Delivery | `apps/bridge/delivery/` (`runner.mjs`, `plan.mjs`, `jobs.mjs`, `checks.mjs`, `ci-watch.mjs`, `release-auto.mjs`, `git-host.mjs`) | Deliver job: developer, review, qa, scripted checks, security on a hit, then push, PR, merge on green (ADR 0024). |
| Meetings | `apps/bridge/meetings/` (`runner.mjs`, `plan.mjs`, `store.mjs`, `prompts.mjs`) | Up to six specialist takes in sequence, then a decision brief (ADR 0017). Routes `routes.mjs:33-41`. |
| Proxy | `apps/bridge/proxy/` | Egress proxy and account/token handling for runs (the wall's network side). |
| Router | `apps/router/` (513 src lines) + `den-router.service` | A separate service beside the bridge that picks work (ADR 0027); stopped by the user since 2026-10-19 (user memory). |
| Service | `apps/bridge/service/den.service`, `den.slice`, `den-launcher.mjs`, `den-service.mjs` | systemd user unit, `Slice=den.slice`, `ExecStart=@NODE@ @STATE@/launcher/den-launcher.mjs`, `Restart=on-failure` (`den.service:9,11,15`), run from release folders under `~/.local/state/den/` (ADR 0026; `CLAUDE.md`). |
| UI | `apps/ui/` (20.4k src lines) | React + React Three Fiber 3D "den" scene, panels, queue, meetings, desk chat. Built by Vite (`package.json` `ui:build`). |
| Checks / CI | `apps/ci-cd/`, `scripts/risk-check.mjs`, `scripts/test-guard.mjs`, `scripts/test-split.mjs` | Dev server, smoke and browser verifier; risk-check decides whether security runs. |
| Hooks and mods | `.claude/hooks/hooks.json`, `scripts/hooks/`, `mods/{sleep-guard,test-run-guard,north-star,queue}` | PreToolUse guards (context budget, bash-guard, test-run-guard, sleep-guard) and status bands. |

### Process model

- One long-lived bridge process per machine under systemd (`apps/bridge/service/den.service:9-15`); `npm run bridge` is the dev path (`package.json`). An edit in the checkout does not change the running den until `npm run den:update` (`CLAUDE.md`).
- Every agent is a child process of the bridge: a Claude Code CLI or Codex process wrapped in bwrap and placed in a systemd slice `den-agents` (`resource-group.mjs:262`, `buildScopeArgv` at `:83`, start gate at `:76`). Checks run in `den-checks` (`:47`), guards in `den-guard` (`:52`).
- Concurrency: `MAX_CONCURRENT_AGENTS = SLOTS.worker` (`agents/policy.mjs:9`), which is 2 worker agents (`CLAUDE.md`, ADR 0002), plus Bao's reserved slot.

### How an agent run starts

1. A request hits `POST /agents/...`, `/conversations/:role/message`, `/deliveries` or `/meetings` (`routes.mjs:18-41`).
2. `host.mjs` checks admission (`agents/admission.mjs:34`, coordinators `bao`/`jiao` at `:14`) and capacity (`host.mjs:426`), makes a worktree (`agents/workspace.mjs`), then calls `runtime.spawn` (`host.mjs:847`).
3. `claude-runtime.mjs:93` validates the spawn: a spawn with no project must sit inside the control checkout (`:101-103`), the main `.git` must be denied or the run refuses (`:110`), credential stores are closed (`:112-113`), and a role with no ceiling does not start (`:117-118`). A delegating role reads its tools and skills from `.claude/agents/<role>.md` frontmatter (`:123-129`).
4. Connection tokens come from `~/.local/state/den/credentials/<name>.token` into a 0600 MCP config file (`:133-148`).
5. The resource launcher wraps the CLI in bwrap + cgroup with the class limits and refuses the run when it cannot enforce them (`CLAUDE.md`, "Direct work"; `resource-group.mjs:142-176` probe and judge).

### The wall and limits

`apps/bridge/agents/limits.json`: worker 2,048 MiB / 100% CPU / 256 tasks; Bao 1,024 MiB / 50% / 128; aggregate 6,144 MiB / 300% / 768; checks 4,096 MiB / 400% / 1,024; storage 4,096 MiB per job, 20 MiB output. Applied as `MemoryMax`, `MemorySwapMax=0`, `CPUQuota`, `TasksMax` (`resource-group.mjs:58`) or cgroup files (`:60`). Storage is polled every 10 s (`:230-238`). A target-project run gets no network and a read-only toolchain (ADR 0021 Amendment 7, decision 27, `docs/adr/0021-...md:302-308`).

### Board

Local markdown under `.scratch/` in the main checkout, its own private git repo (`CLAUDE.md`, `docs/agents/issue-tracker.md`, ADR 0003). Behind the wall the board is read-only to a run; the bridge makes the board calls (friction F3, F38, F46 in `.scratch/den-mvp/friction.md:9,44,52`). A GitHub Issues board adapter exists (`apps/bridge/board/github-issues.mjs`), with a `den:in-review` label (ADR 0021 A7 decision 25, `:291`).

### Delivery

`delivery/plan.mjs:5-22`: `nextStep(job)` starts roles from the risk floor plus owner additions; the code reviewer reads every diff, qa checks behaviour, a red local check goes back to the developer like a bounce, a UI-affecting candidate is reviewed by security (ADR 0026 decisions 5-6). The job log is append-only with intent/outcome lines for side effects (`delivery/jobs.mjs:1-5`; ops `claim, release, push, pr, merge, golive, resolve` at `:14`). **Deliver refuses any project but the den**: `DEN_ONLY` (`delivery/runner.mjs:113`, enforced at `:246` and `:830`).

### Meetings

`apps/bridge/meetings/` runs takes in sequence and writes takes and brief under `.scratch/<feature>/meetings/`; choosing an option writes a ticket at `ready-for-human` (`CLAUDE.md`, ADR 0017 Amendment 1). Routes: create, read, resume, stop, close, decide, ask (`routes.mjs:33-41`).

## 2. Tech stack and its costs

Off the shelf: Node ESM, `node --test`, Vite 8.3.4, Playwright 1.63.0 (dev); React 19.3, React Three Fiber 9.8.1, three 0.170, react-markdown, remark-gfm (`package.json`). Six runtime dependencies in total. Claude Code CLI and Codex app-server as agent runtimes; bwrap, systemd user units and cgroups v2; optional rootless Docker (`scripts/install-rootless-docker.sh`); `gh` for the git host.

Custom (everything else): HTTP server and router, auth/launch codes, the board and its CLI, lock-file claims, the delivery state machine, the CI watcher, the release/update/rollback system (`apps/bridge/build/`), the egress proxy, the sandbox compiler, the meeting runner, the router service, the 3D UI, Jev routing scripts, context-budget and bash guards.

Size (tracked files, `.mjs/.js/.jsx/.ts/.css`, non-test vs `*.test.mjs`):

| Area | Source lines | Test lines | Test files |
|---|---:|---:|---:|
| `apps/bridge` | 18,665 | 31,360 | 158 |
| `apps/ui` | 20,412 | 21,316 | 169 |
| `scripts` | 8,857 | 23,316 | 131 |
| `apps/board` | 3,147 | 7,787 | 40 |
| `apps/ci-cd` | 1,180 | 1,329 | 10 |
| `apps/router` | 513 | 910 | 5 |
| `packages` | 179 | 265 | 3 |
| `mods` | 455 | 0 | 0 |
| `apps/shared` | 113 | 29 | 1 |
| **Total** | **~53.5k** | **~86.3k** | **517** |

- About 5,361 `test(`/`it(` calls across 517 test files; 25 are browser tests (`*.browser.test.mjs`) that each start a Chromium (user memory: "Test runs leave orphan browsers").
- Prose that agents load: 77 tracked files under `.claude/skills/` (35 skills, several vendored, `.claude/skills/VENDORED.md`); `.claude/skills` + `.claude/agents` + `docs` markdown is ~9.5k lines; `CONTEXT.md` 334 lines; 32 ADRs (`docs/adr/0001` to `0032`), ADR 0021 alone has 7 amendments.
- Cost signals: test code is 1.6x source; the bridge is the single biggest module (host.mjs 1,563 lines, server.mjs 1,293); the whole test suite needs a lock and splitter (`scripts/test-lock.mjs`, `scripts/test-split.mjs`) and a CPU slice (PR ci-cd/15, commit `9b1fa4ed`).

## 3. Portability today

There are three separate portability paths, at different maturity.

### 3a. The `den` plugin (kit, PRs #439-#441)

- Ships: `.claude/` as a plugin named `den` (`.claude/.claude-plugin/plugin.json`): 12 role definitions (`.claude/agents/*.md`), 35 skills, `commands/`, and `hooks/hooks.json`. Listed in the marketplace as source `./.claude` (`.claude-plugin/marketplace.json`).
- Role allow-lists name both spellings, `Agent(developer, ..., den:developer, ...)`, so a plugin chief of staff can start workers (`.claude/agents/chief-of-staff.md` frontmatter; commit `d51a58d6`).
- Companion CLI `den` (`scripts/den-cli.mjs`): `board`, `status`, `test`, `risk-check`, `usage`, `init`, `install` (`:2-9`). `den install` symlinks the script into `~/.local/bin` (`:145-155`). `den init` writes `.den/project.json` (defaults `test: "npm test --"`, a code-path list, `guardrailPaths: []`, `:18-22`), appends `.scratch/` to `.gitignore`, and appends an "Agents (den kit)" section to the target's `CLAUDE.md` (`:99-143`).
- Checks trust the base branch's `.den/project.json`, not the branch's (`:32-48`), and the board is pinned to the target's main checkout ignoring an ambient `DEN_ROOT` (`:68-75`).

What a target must have: a git repo with a `main` branch (`readConfig` defaults to `main`, `:34`, `:60`); Node; the den checkout on the same machine (every `den` subcommand runs a script from the den checkout, `:16`, `:74`, `:86`, `:89`); `~/.local/bin` on PATH; the session started with `claude --plugin-dir <den>/.claude` (`:141`).

Gaps:
- **Hooks reach outside the plugin root.** Every guard runs `${CLAUDE_PLUGIN_ROOT}/../scripts/hooks/...` or `../mods/...` and fails closed with exit 2 when missing (`.claude/hooks/hooks.json:9,19,24,29`). With `--plugin-dir <den>/.claude` the parent is the den checkout and this works. If the plugin is installed from the marketplace by name (the stated purpose of #441, "so CI can install it by name", commit `84587371`), the installed copy would hold only `.claude/`; if so, the context-budget hook, which has no matcher, would block every tool call. Not verified here; worth one test install before the meeting relies on it.
- **The den checkout is a runtime dependency.** Board, risk-check and usage all execute den-repo files (`den-cli.mjs:74,86,89`); there is no packaged release of the kit.
- **The board is still `.scratch/` markdown** in the target's main checkout (`den-cli.mjs:68-75`, `:135`); `den init` creates a bare `.scratch/` with no issues layout.
- **Den-only tools are missing in a target** and agents are told to skip them: `jg`, `test-guard`, `pr-map`, `session-check`, `verify:ui`, `den:update` (`den-cli.mjs:117`). The skills still reference den docs that are absent there (same line).
- `den test` splits the configured command on whitespace (`:79`), so a quoted or piped test command does not work.

### 3b. The `den-roles` plugin (PRs #442-#443)

- Ships role files only: `architect, code-reviewer, developer, qa, security, technical-writer` (`scripts/den-roles-sync.mjs:16`) into `plugins/den-roles/agents/`, generated from `.claude/agents/` plus `scripts/den-roles-protocol.md`. It drops `Agent(...)`, `Skill`, `AskUserQuestion`, `Artifact`, `mcp__*` (`:18`), drops `skills`/`isolation`/`org` (`:5-7`), and adds the claude-code-action comment tool (`:21`, `:45`).
- Use: a target's GitHub Actions runs claude-code-action with `plugins: den-roles@dimsumden-mods`, and `@claude <role>` on a PR runs that role (`:2-3`). The protocol says: no board, no bridge, no handoffs; writers commit on the branch and the workflow pushes; reviewers don't edit; no dependency, CI, `.claude/`, `.den/` or `CLAUDE.md` changes; report once in the tracking comment and name the next `@claude <role>` for the owner to post (`scripts/den-roles-protocol.md:3-9`).
- Gaps: no relay automation, the owner hand-posts each next step (`den-roles-protocol.md:9`); no skills (team-protocol, tdd, code-review) reach CI (`den-roles-sync.mjs:5-7`); no chief of staff, product, designer, release-manager, sre or runner; a drift check exists (`--check`, `:72-75`) but I did not find it wired into CI in this audit. First field evidence is "docviz #1", where both runs left only the placeholder comment until #443 (`den-roles-sync.mjs:19-21`).

### 3c. Bridge multi-project (ADR 0021 Amendment 7, multi-project/01-04, PRs #433-#436)

- A project registry (`apps/bridge/projects.mjs`, `scripts/den-project.mjs`), `npm run den:project -- add <slug> <path> --board github-issues --repo owner/name --checks ... --toolchain ...` and `verify` (`docs/agents/target-project-setup.md:9-16`).
- A target run reads `.den/ticket.md`, mounts its toolchain read-only, and has no network (`target-project-setup.md:17-24`; ADR 0021 A7 decisions 26-27).
- Gaps: **Deliver still refuses non-den projects** (`delivery/runner.mjs:113,246,830`); only one active project at a time until the first target change merges (ADR 0021 A7 decision 29, `:318-322`); multi-project/05-06 (target delivery policy and lifting the mutex) are not merged per git log; a native module built on the WSL host may not load in the bookworm image (`target-project-setup.md:20`, A7 `:308`).

### Still den-repo-only (all paths)

- systemd user service and slices, release folders and credentials under `~/.local/state/den/` (`den.service:9-15`; `claude-runtime.mjs:136`); 5 non-test `.mjs` files name `.local/state/den`.
- Linux-only enforcement: bwrap, systemd scopes, cgroups v2 (`resource-group.mjs:58-83`); WSL quirks recorded in user memory (hidden user bus, WSL freeze).
- The control checkout as the trusted source of role frontmatter and settings: a spawn with no project must run inside it (`claude-runtime.mjs:101-103`, `:123`).
- The 3D UI, meetings, router and Jev are den-only; none ship in either plugin.

## 4. Recurring friction

### Friction log (`.scratch/den-mvp/friction.md`, 49 rows, F1-F49, 2026-10-14 to 2026-10-22+)

| Theme | Rows | Count |
|---|---|---:|
| The wall blocks a normal step (board EROFS, no gh, no `/tmp`, no Monitor, live probes refused, git fetch refused, worktree/branch guards) | F1, F2, F3, F4, F5, F9, F10, F35, F38, F45, F48, F49 | 12 |
| Resource limits and test load (256-task cap, 2 GiB Chrome OOM, whole-suite runs, flakes under load) | F12, F17, F27, F30, F33, F37, F41 | 7 |
| Delivery state machine edge cases (false pauses, no-checks on conflict, paused overnight, no note on resume, local checks used stale deps) | F11, F13, F26, F28, F29, F36 | 6 |
| Bao / desk UX (asks as Allow/Deny, raw JSON asks, one ask per ticket, malformed board_file tickets, cannot act on board, no images) | F16, F18, F20, F21, F23, F24, F25, F34 | 8 |
| Relay routing lost (orchestrator ended before children reported; reports went to the main session; short refs refused) | F42, F43, F47 | 3 |
| Service and update (den:update broke twice, a test wiped live previews, stale usage readings, login link once) | F14, F15, F19, F31, F39, F44 | 6 |
| Housekeeping (59 leftover worktrees, design ticket has no den path, layout crowding) | F22, F32, F40 | 3 |

Most rows are marked fixed or obsolete as of the 2026-10-22 triage; the pattern is that each new guard or wall rule created the next row (F27 fix caused F33, `friction.md:39`; F23-F25 and F34 all trace to one tool, `board_file`).

### Git history

- 1,929 commits since 2026-09-26 (34 days): 1,520 non-merge, 409 merges.
- Commits by ticket area (subject prefix, all time): `organism-infra` 158, `den-mvp` 92, `ui` 61, `hardening` 52, `team-and-den-ux` 25, `ci-cd` 25, `multi-project` 22, `bridge` 19, `queue` 15, `agent-os` 11, `den-revival` 10, `den-layout` 10, `kit` 9, `adr` 9, `trust-ladder` 8, `codex` 8, `meetings` 7. Infra, hardening, CI and agent-OS areas (~300) outnumber UI and scene areas (~90) by about 3 to 1.
- Last 150 non-merge commits (roughly 2026-10-23 to 10-30): 44 start with `fix`, 20 with `feat`; 35 are multi-project or kit; 56 subjects name relay, guard, wall, hook, sandbox, board, claim, handoff, role, worktree, kit or codex; 21 are UI/scene polish; 12 meetings; 4 WIP. 46 commits overall are labelled fix rounds.
- The kit itself needed 6 follow-up fixes in 4 PRs right after it landed (`473ea0a0`, `06c6c4f3`, `c1e7b89f`, `d51a58d6`, `ca262969`, `adfe93e0`), and the bash-guard needed 4 commits in PR #438 (`b7151073` to `ba3f5356`).

## 5. Facts a meeting should know

1. The den is ~53.5k lines of custom source with ~86k lines of tests in 517 files, on six runtime dependencies; nearly all infrastructure (board, delivery, proxy, sandbox, release system) is hand-built (section 2; `package.json`).
2. Every agent run is a CLI child of one bridge process, behind bwrap and a cgroup, and refuses to start when the wall cannot be enforced (`apps/bridge/agents/claude-runtime.mjs:101-118`; `resource-group.mjs:83`).
3. Two worker slots plus Bao on one machine with a 6 GiB agent aggregate is the hard throughput ceiling (`apps/bridge/agents/limits.json`; `agents/policy.mjs:9`; `host.mjs:426`).
4. Deliver, the den's end-to-end relay, refuses any project but the den today (`apps/bridge/delivery/runner.mjs:113,246,830`).
5. Two plugins exist: `den` (full roles, skills, guards; needs the den checkout beside it) and `den-roles` (6 roles for GitHub Actions; no skills, no board, owner hand-posts each step) (`.claude-plugin/marketplace.json`; `scripts/den-roles-sync.mjs:16-21`; `scripts/den-roles-protocol.md`).
6. The `den` plugin's guards resolve `../scripts` and `../mods` from the plugin root and fail closed; a marketplace install by name likely lacks those paths (`.claude/hooks/hooks.json:9-29`; unverified, test before relying on it).
7. A target using the kit still gets a `.scratch/` markdown board, the den's test/risk scripts run from the den checkout, and `main` as the assumed base (`scripts/den-cli.mjs:16,34,60,68-75,135`).
8. The bridge path to other projects (GitHub Issues board, `.den/ticket.md`, read-only toolchain, no network) is built through multi-project/04 but keeps one active project at a time (`docs/agents/target-project-setup.md`; ADR 0021 A7 decision 29).
9. The service model is Linux/WSL-specific: systemd user units, slices, state under `~/.local/state/den/` (`apps/bridge/service/den.service:9-15`; ADR 0026).
10. Friction is dominated by the wall and limits blocking normal steps (12 of 49 rows) and by test load against resource caps (7 rows) (`.scratch/den-mvp/friction.md`).
11. Recent effort is mostly plumbing: of the last 150 non-merge commits, 44 are fixes and 35 are multi-project/kit, against 21 UI commits (section 4, `git log`).
12. Governance load is high: 32 ADRs, ADR 0021 alone with 7 amendments, 35 skills and 12 roles agents must load (`docs/adr/`; `.claude/skills/`; `.claude/agents/`).
