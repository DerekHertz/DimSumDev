> [!WARNING]
> **Work in progress.** DimSumDev is built for one person's workflow (mine), and the agents in it rebuild it every day.
> Expect breaking changes: keys that move, panels that get redrawn, features that come and go without notice.
> If it's close to what you want, fork it and bend it into what you need.

<div align="center">

# 🥟 DimSumDev

**A local control room where a small team of AI agents builds software, and you sit at the Pass.**

Agents work tickets through a strict relay on a plain-file board, stop at gates only you can open,
and show up as plush pandas in a 3D bamboo garden, around Bao, so you can see who is doing what at a glance.

[![CI](https://img.shields.io/github/actions/workflow/status/DerekHertz/DimSumDev/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/DerekHertz/DimSumDev/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20WSL-lightgrey?style=flat-square)](#requirements)
[![Built with React Three Fiber](https://img.shields.io/badge/built%20with-React%20Three%20Fiber-000000?style=flat-square)](https://r3f.docs.pmnd.rs)
[![Runs on Claude Code](https://img.shields.io/badge/runs%20on-Claude%20Code-d97757?style=flat-square)](https://code.claude.com)

[**Run locally**](#run-locally) · [**Controls**](#controls) · [**How it works**](#how-it-works) · [**Numbers**](#numbers) · [**Development**](#development) · [**Glossary**](CONTEXT.md) · [**Decisions**](docs/adr/)

```sh
npm ci && npm run ui    # then open http://127.0.0.1:4317/?demo=den
```

[![DimSumDev: a living world for your AI dev team, showing the global garden view and your desk](docs/images/dimsumdev-preview.png)](docs/videos/dimsumdev-linkedin.mp4)


*Captured from the running app in Demo mode (`?demo=den`). The preview uses the demo's recorded and staged events; steering actions are disabled.*

</div>

---

## What it is

- **A team, not a swarm.** Nine roles (`product`, `architect`, `orchestrator`, `developer`, `scout`, `qa`, `security`, `designer`, `herald`), each a Claude Code session running one ticket in its own git worktree. A role is a markdown file in `.claude/agents/` that fixes its model, tools, skills and done criteria.
- **A kitchen, roughly.** Roles sit at teams named for a dim sum kitchen. The Pass (orchestrator, product, architect) decides and sequences. Steamers (developer, scout) build and dig. Tea & Pantry (qa, security) test and guard. Front of House (designer, herald) keeps things looking right and drafts the public posts.
- **A relay for every code ticket.** qa writes failing tests, a developer makes them pass, qa verifies, a risk check decides whether security reviews, and the orchestrator opens the PR and merges on green CI ([ADR 0002](docs/adr/0002-relay-not-swarm.md)).
- **Gates you can't miss.** Agents stop before pushing, adding a dependency, or editing an ADR or their own role files. You approve a ticket once; the orchestrator runs its whole relay and only comes back for a visual check, a design question, a ticket that failed twice, or a red merge.
- **A board you can diff.** Tickets are markdown under `.scratch/`, claimed with lock files and handed off through a `board` CLI ([ADR 0003](docs/adr/0003-local-file-board.md), [ADR 0008](docs/adr/0008-board-service.md)). No database, no hosted service.
- **The den.** `apps/ui` is a React Three Fiber garden: Bao at the center, a pavilion per team, and plush pandas dressed for their role. Beside it, your desk holds the queue, what needs you, meetings and the library, with tabs for Work, Pandas and Library and a Talk to Bao button. Zoom from the whole den to a team, a panda or its workspace, or press Enter the den to walk around; walk up to an agent to read its transcript, message it, or approve or deny what it's waiting on.
- **Demo mode.** Open `?demo=den` or press **Watch the demo** to replay a recorded session into the den. It makes no bridge calls and reads no tokens, and every action that would steer a real agent is greyed out.
- **Cheap decisions, logged before trusted.** Routine relay choices (which model a developer needs, how deep qa verifies) go to Jev, a small typed-decision model, through `scripts/jev.mjs`. It runs in shadow mode: each pick is logged beside what the relay actually did, and any error or missing key falls back to the current rule ([ADR 0010](docs/adr/0010-jev-precheck-tier-and-verify-depth.md)).

## Requirements

- Node.js and npm.
- [Claude Code](https://code.claude.com) on your own subscription, to run the agents ([ADR 0001](docs/adr/0001-subscription-cli-cells.md)).
- `git`, and the GitHub CLI (`gh`) for the orchestrator's PRs and CI checks.
- Optional: Playwright's Chromium, for `npm run smoke:ui`.

Linux, macOS and WSL. It's a local tool, and the bridge binds to `127.0.0.1` only.

## Run locally

```sh
git clone https://github.com/DerekHertz/DimSumDev.git
cd DimSumDev
npm ci
npm run ui              # builds the UI, then starts the bridge on port 4317
```

Open <http://127.0.0.1:4317/>. With no agents running, add `?demo=den` to watch a recorded session.

### Run it as a service (Linux and WSL, systemd and bubblewrap)

```sh
npm run den:install     # once: packages, first release, the service; the den then answers on 4317
npm run den:update      # after merging a change to `main`: new release, links switched, service restarted
```

The service runs from release folders under `~/.local/state/den/` (a copy of `main`, its UI built in a sandbox), not from the checkout, so editing the checkout does not change the running den ([ADR 0026](docs/adr/0026-the-den-serves-itself.md)). Both commands print each step and refuse before changing anything on a host without a systemd user manager or bubblewrap. `npm run bridge` is for development: run it with `PORT=4400 npm run bridge`, on another port than the service.

Run an agent as its own Claude Code session:

```sh
claude --agent orchestrator     # proposes tickets and runs the relay
claude --agent developer        # or any other role in .claude/agents/
npm run next-session            # prints the command to resume from the latest handoff
```

## Controls

| Visit an agent | Enter the den |
| --- | --- |
| ![DimSumDev agent view: a developer panda at Steamers with its tool calls and message exchange open at your desk](docs/images/dimsumdev-agents.png) | ![DimSumDev first-person view: visiting the pandas at the Steamers workstations after touring the tea garden and Bao's courtyard](docs/images/dimsumdev-walk.png) |

<details>
<summary>Preview the first-person view</summary>

![A first-person tour past the tea garden, Bao's courtyard and the Steamers workstations](docs/images/dimsumdev-walk.gif)

</details>

| Key | Action |
| --- | --- |
| Enter the den | Enter walk mode (the on-screen W A S D pad works on touch screens) |
| W A S D / arrows | Walk; hold Shift to go faster |
| Mouse drag | Look around; double-click to grab the pointer again |
| Tab | Free the cursor to click a card |
| Esc | Close the transcript, or leave walk mode |
| Click a panda | In the overview, open that panda's card (the one walk mode shows when you stand near it) |
| R | Open the transcript of the agent whose card is showing |
| T | Message that agent, or give a resident panda a task |
| E / Q | Open the permission request that's waiting (that panda's, or the first in Needs you), then allow or deny it |
| J / K | Next or previous request on a card |
| M | Jump to the note field on a card |
| Ctrl/Cmd + Enter | Send the card's action |
| Ctrl/Cmd + K | Focus the input bar |
| 1 Den · 2 Team · 3 Panda · 4 Workspace | Jump the overview camera to a zoom level |
| + / − / wheel / pinch | Zoom the overview camera |
| ← / → / drag | Pan the overview camera |

## How it works

```
 you ── approve ticket ──▶ orchestrator ──▶ qa specify ──▶ developer ──▶ qa verify ──▶ risk-check ──▶ PR ──▶ merge on green
                                │                                                         │
                                └──── board (.scratch/, locks, handoffs) ◀────────────────┘
                                                      │
                                      bridge (127.0.0.1:4317, /state, /events) ──▶ den UI
```

- **Bridge.** `apps/bridge` reads the board, streams changes over server-sent events at `/events`, and serves `/state` and `/metrics` ([ADR 0011](docs/adr/0011-ui-v0-seams-bridge-snapshot-scene.md)). What you do in the den (approvals, messages) goes back as requests that the orchestrator acts on.
- **Mechanical checks.** The rules agents skip most are enforced by scripts, not by asking nicely: `npm run risk-check`, `npm run check:bom`, `npm run session-check`, and a release gate that won't let an agent drop a ticket without a handoff ([ADR 0009](docs/adr/0009-mechanical-checks-for-most-skipped-rules.md)).
- **Spend you can see.** Every agent run is logged to `.scratch/usage.jsonl` with its model, tokens and time. `npm run spend` totals them per ticket and per role.

- **Agents from the den.** Press T beside a resident panda that has no agent and type a task. The bridge writes a ticket under `.scratch/den/` and starts that role's Claude Code agent in its own git worktree. Its tool calls, permission requests, final reply and cost show on the panda's card, and you can message it while it works. A permission request also shows in the Needs you card and in the transcript, with Deny and Allow ([ADR 0016](docs/adr/0016-ui-steering-channel.md)).

  ![DimSumDev in motion: the global garden view, opening a developer panda's conversation, and walking through the den](docs/images/dimsumdev-preview.gif)

  *Demo mode in the running app, moving from the global view to a developer's card and conversation, then taking a first-person tour past the tea garden, Bao's courtyard and Steamers. The scout's events are from a recorded run; the developer and qa storylines are staged. Steering actions are disabled. [Download the MP4 with captions and an original soundtrack](docs/videos/dimsumdev-linkedin.mp4).*

- **Delivery from the den.** Deliver on a ticket runs the developer, qa's verify, the scripted checks and, on a hit, security; then the bridge pushes, opens the PR and merges on green checks ([ADR 0024](docs/adr/0024-delivery-jobs.md)). A change to the bridge, a guardrail or CI is left for you to merge.
- **Meetings.** Ask up to six specialists for one take each; Bao then writes a decision brief with two or three options, and choosing one writes a ticket for your approval ([ADR 0017](docs/adr/0017-meetings-and-decision-briefs.md)).

Not built yet: runtimes other than Claude Code ([ADR 0004](docs/adr/0004-runtime-adapter.md) sketches the adapter).

## Numbers

All of these can be re-run, as of `757dbda`.

- **1,368 commits on `main`**, 255 of them merges: `git log --oneline 757dbda | wc -l`, then add `--merges`.
- **342 test files**: `find apps packages scripts -name "*.test.mjs" -not -path "*/node_modules/*" | wc -l`.
- **26 recorded decisions** in [`docs/adr/`](docs/adr/).
- **791 logged agent runs across 169 tickets, about 127.8 million tokens**: the `kind:"cell"` rows of `.scratch/usage.jsonl`, summing `tokens` (17 early rows carry no token count).

## Development

```sh
npm test                # node:test across apps, packages and scripts (runs check:bom first)
npm run ui:dev          # Vite dev server for the UI alone
npm run bridge          # the bridge alone (development; the service is `den:install`)
npm run smoke           # HTTP smoke check
npm run smoke:ui        # browser smoke check (Playwright + Chromium)
npm run risk-check      # decides whether a branch needs a security review
npm run board -- status <feature>/<NN-slug>
```

Layout: `apps/ui` (React + React Three Fiber, built by Vite, the only build step), `apps/bridge` (localhost server), `apps/organism-infra` (the board CLI), `apps/ci-cd` (dev server and smoke checks), `scripts/` (relay tooling). Everything else is Node ESM run with `node --test`.

### Refresh the README media

With the existing Playwright Chromium and `ffmpeg` / `ffprobe` installed:

```sh
PW_GPU=1 DISPLAY=:0 node scripts/capture-readme.mjs   # WSL GPU; omit these variables for headless capture
node scripts/render-readme-media.mjs
```

The capture runs an isolated Vite server with local responses for bridge reads. It uses the demo fixture, opens a panda's conversation, and walks through the garden without launching agents. Screenshots and GIFs go to `docs/images/`; the 18-second, 1920 × 1080 H.264/AAC video goes to `docs/videos/dimsumdev-linkedin.mp4`. Temporary footage stays under the system temp directory. The video includes captions for muted playback and an original synthesized soundtrack.

### Claude Code settings

Once you trust this folder in Claude Code, `.claude/settings.json` runs repo scripts as hooks: `scripts/session-start.mjs` on start, `scripts/hooks/context-budget.mjs` before each tool call, and `scripts/notify.mjs` on notifications and stop, plus `scripts/statusline.mjs` for the status line. To show plan usage, `scripts/usage-claude.mjs` reads your Claude Code login (`~/.claude/.credentials.json`, or the macOS Keychain) and sends it only to `api.anthropic.com`. The shared allow list holds read-only commands; put push and PR permissions in your own `.claude/settings.local.json`. Read changes to `scripts/` and `.claude/` in an outside pull request before you open its branch in Claude Code.

The board (`.scratch/`) is not part of this repo; without one, the board is simply empty.

## More

- [`CONTEXT.md`](CONTEXT.md): the glossary (org, team, agent, role definition, Bao, perch and the rest).
- [`docs/adr/`](docs/adr/): every recorded decision and why it was made.
- [`docs/agents/`](docs/agents/): how agents use the board, worktrees and process hygiene.

## License

[MIT](LICENSE)
