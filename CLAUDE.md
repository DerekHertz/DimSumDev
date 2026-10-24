# Dim Sum Dev (formerly Dim Sum Den, before that Agent Office)

A local web app for observing and steering AI agents across the SDLC, organized as an engineering org of roles and teams. Vocabulary lives in `CONTEXT.md`; use its terms. Decisions live in `docs/adr/`.

Stack: Node ESM scripts (`.mjs`, tests via `node --test`); Vite is the only build step. `apps/ui` is React + React Three Fiber; `apps/bridge` serves the UI and board state; `apps/board` is the board CLI; `apps/ci-cd` holds the dev server and smoke scripts; `scripts/` holds relay tooling. Common scripts: `npm test`, `npm run board -- <cmd>`, `npm run ui`, `npm run smoke:ui`, `npm run risk-check`.

The den runs as a systemd user service (ADR 0026), from release folders under `~/.local/state/den/`, not from the checkout. The user runs `npm run den:install` once and `npm run den:update` after merging a bridge change; an edit in the checkout does not change the running den. `npm run bridge` is for development, and takes `PORT=<other>`.

## Agents

Roles are defined by role definitions in `.claude/agents/`, grouped into teams. Each role's contract (inputs, outputs, authority, hand-offs) and the user's approval points are in `docs/agents/team-charter.md` (ADR 0029):
- `chief-of-staff` (Bao is its Claude instance, Jiao its Codex instance), `product`, `architect`, `release-manager` (Pass); `orchestrator` is only Bao's desk key in the den, running the chief of staff's definition
- `developer`, `runner` (Steamers); `runner` is a Haiku leaf that starts no agent: the agent tree is Bao and the router, then Sonnet agents, then leaves
- `code-reviewer`, `qa`, `security`, `sre` (Tea & Pantry); `sre` runs on Haiku, observes and proposes only
- `designer`, `technical-writer` (Front of House); the writer keeps docs true and drafts public posts, the user publishes
- `orchestrator`, `herald` and `scout` are retired (team-and-den-ux/19): into the chief of staff, the technical writer, and the runner

Code tickets run a relay sized to risk (`team-protocol`, "Relay size"). Every code ticket goes to the developer, who writes the failing tests first, then qa `verify` (a per-criterion map to a test that fails without the change, and a verdict on each test-guard hit); qa has no `specify` mode. A risk-path ticket is one on the wall, CI, hooks, service, auth or dependencies. On every code ticket the `code-reviewer` reviews the developer's commit beside qa, and the developer does not review its own work; one fix round carries both reviews' findings. Then `npm run risk-check`: a clean exit skips `security`, a hit dispatches it. Push, PR and merge on green CI are the release manager's steps: the bridge runs them in a delivery, the chief of staff in a terminal relay. designer specs UI tickets with the user (a detailed spec plus low-cost mockups), and the user does all visual critique of UI and asset tickets until a cheaper automated critique exists. Every agent follows the `team-protocol` skill: claim before working, stop at pass gates, hand off, then end.

Relay autonomy (see `team-protocol`): once the user approves a ticket, the chief of staff runs its relay end to end, PR and merge included. Other gates still apply. It stops for user verdicts, open scope questions, a twice-failed ticket, environment issues, 5-hour usage at 90%+, or a red or conflicted merge. Up to two worker agents run at once (`max_concurrent_agents: 2`), on different tickets with non-overlapping files; Bao has a reserved slot beside them.

Direct work (`.scratch/den-mvp/spec.md`): the user may give any panda a focused job from the den without the relay, including developer, qa and security. The bridge starts every agent behind the wall and inside a resource group (`apps/bridge/agents/limits.json`), and refuses the run when it cannot enforce them. Push, PR and merge still need the delivery checks.

Delivery (ADR 0024, ADR 0029): Deliver on a ticket in the den runs developer, `code-reviewer`, qa `verify`, the scripted checks and, on a hit, security; then the bridge pushes, opens the PR and merges on green checks, as the release manager's steps. The bridge makes the board calls and holds the git-host login; a change to the bridge, a guardrail or CI is left for the user to merge.

Meetings (ADR 0017, Amendment 1): from the den the user asks up to six specialists for one take each, in sequence; Bao then writes a decision brief with two or three options. The bridge runs it and writes the takes and the brief under `.scratch/<feature>/meetings/`. Choosing an option writes a ticket at `ready-for-human`; a brief authorizes nothing.

Run an agent as the main session with `claude --agent <role>`. If a session is asked to act as an agent without that flag, read `.claude/agents/<role>.md` first and follow it.

## Cloud sessions

Environment setup for cloud containers (browser path, proxy, usage readings) lives in `docs/agents/cloud-sessions.md`; read it when `CLAUDE_CODE_REMOTE` is set. Locally (WSL or macOS) none of it applies.

## Agent skills

### Issue tracker

The board is local markdown under `.scratch/` in the main checkout, with lock-file claims. `.scratch/` is its own private git repo, ignored by this one. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Token hygiene

This runs on a Pro plan. Keep this file short, read narrowly, and delegate verbose output to `runner`.

# Compact instructions

When compacting, keep: the current ticket path, acceptance criteria status, the branch, and unresolved errors. Drop exploration output.
