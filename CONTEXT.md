# Dim Sum Dev

Formerly Agent Office. A personal control room for observing and steering AI agents across the software development life cycle. The agents are organized as an engineering org: roles, grouped into teams (ADR 0028). The older biology names (organism, cell, genome, station, apoptosis) appear in ADRs before 0028.

## Structure

**Org**:
One project (one git repo) and every agent working on it.
_Avoid_: Organism (the old name, ADR 0028), office, workspace, swarm

**Control project**:
This repo: the den's bridge code, role files, governance and policy. It is never taken from a working directory or a client.
_Avoid_: Home repo, host repo

**Target project**:
A repo the den works for, like a client of an agency: its own source, tickets, board and queue, all reached from the den. The den's own repo is one too; the first other is `safety-aware-route-planner`. On another project, nothing of its `.claude/` loads; the bridge passes in its `CLAUDE.md` or `AGENTS.md` as project knowledge (ADR 0021 Amendment 4).
_Avoid_: Client repo, workspace

**Active project**:
The one target project runs and deliveries happen in, chosen in the den. Every project's board and queue can be opened at any time; a switch is refused while runs are active.
_Avoid_: Current repo, selected workspace

**Project registry**:
The den's list of onboarded projects: a slug, a plain path, a board kind and the toolchain a run may read. It lives in the den's state, not in the repo, and only the user's terminal writes it. The control project is always in it, implicitly (ADR 0021 Amendment 5).
_Avoid_: Project config, workspace list

**Team**:
A group of roles that owns one SDLC outcome, drawn as a place on Bao: the Pass (orchestrator, product, architect), Steamers (developer, scout), Tea & Pantry (qa, security), Front of House (designer), Service, Meter, Recipe book, Order rail. See the table in `design-brief.md` §4.2.
_Avoid_: Station and organ (the old names, ADR 0028 and organism-infra/53), department, squad

**Role**:
A job an agent can do (developer, qa, designer, ...), with its prompt, tools, model, skills, gates and done criteria set by its role definition.
_Avoid_: Cell type (the old name, ADR 0028), agent type, persona

**Role definition**:
The file that defines a role: `.claude/agents/<role>.md`.
_Avoid_: Genome (the old name, ADR 0028), agent config

**Agent**:
One running instance of a role, working one ticket, usually in its own git worktree.
_Avoid_: Cell (the old name, ADR 0028), worker, bot

**Bao**:
The orchestrator's on-screen body: a large seated plush panda at the heart of the den. Walking up to Bao is talking to the orchestrator (ADR 0019).
_Avoid_: Mascot, avatar

**Resident panda**:
The one panda per role that is always in the den at its team, whether or not an agent of that role is running.
_Avoid_: Idle placeholder, NPC

**Take over**:
What an agent does to its role's resident panda when it starts: the panda now shows that agent's state, ticket and tool calls, and returns to resident when the agent ends. A second concurrent agent of the same role splits off a panda of its own that fades when it ends.
_Avoid_: Possess, inhabit

**Walk mode**:
The first-person view of the den: you walk up to a panda and act on it from its card.
_Avoid_: FPS mode, free cam

**Perch**:
The spot on Bao or the grass where an agent sits. Agents hop or waddle between perches.
_Avoid_: Slot, seat, position

**Leisure area**:
A place in the den where pandas rest between tasks (tea, mahjong, training, a festival stage, dim sum dining). It belongs to no team. Part of the den-layout direction (ADR 0019, Amendment 1).
_Avoid_: Break room, lounge

**Build pad**:
A reserved plot at the rear of the den for a team that does not exist yet. It is marked out and numbered, and holds nothing until a team is built on it.
_Avoid_: Empty slot, placeholder team

**Scenery panda**:
A panda with no role definition: it fills a planned future role (release-manager, knowledge-keeper, docs-writer, stem-cub) so the den reads as populated, but nothing can dispatch it. It is not a resident panda and is not a role. The four roles above stay scenery until one gets a role definition and its own CONTEXT.md entry.
_Avoid_: NPC, extra, placeholder agent

**Runtime**:
The agent program that runs an agent (Claude Code, Codex CLI, Gemini CLI, OpenCode, local model).
_Avoid_: Provider, engine

## Work

**Board**:
The local-markdown issue tracker under `.scratch/` in the main checkout, and the single source of truth for work.
_Avoid_: Backlog. Do not call the board "the queue"; **Queue** names the ordered frontier below.

**Kanban**:
The Den view of the board as columns (proposed, ready, in flight, waiting on you, blocked, resolved). The user may move a card only across their own gates; a claimed card is pinned. The terminal band (a mod, `/queue`) shows the same columns in text.
_Avoid_: Dashboard, board view

**Board service**:
The module behind the `board` CLI; the single writer of the board.
_Avoid_: Board server, board API

**Board event**:
One line in the board's `events.jsonl`, recording a single board change. Agents and the UI subscribe to these lines.
_Avoid_: Board message, notification

**Ticket**:
One tracer-bullet slice of work on the board, sized for one agent.
_Avoid_: Issue, task, story

**Frontier**:
The tickets that are ready, unblocked, and unclaimed right now. An unordered set.

**Queue**:
The frontier in its computed order: the active feature's tickets first, then the rest, each group ordered by unblock count, then priority, then ticket number. Only a P0 with a named reason jumps the active feature. It is computed on every read, never stored.
_Avoid_: Backlog, board (the board is the whole tracker, not the order)

**Goal**:
One of the user's few standing aims for the den, listed with its reason and "done when" in `.scratch/goals.md`. Every open ticket names the goal it serves on a `Goal:` line, so the board can show what each ticket is for. Only the user changes the list; Bao may propose a change.
_Avoid_: Epic, theme, initiative. Not the same as a ticket's `Serves:` line, which is the admission gate's machine form.

**Active feature**:
The one feature whose ready tickets outrank all others in the Queue. Only the user sets it.

**Parked**:
A ticket taken off the relay because it serves no den-loop step or testbed friction yet. It comes back with `board unpark`.
_Avoid_: Backlog, icebox

**Closed**:
A ticket that will not be done, with the reason in its comments.
_Avoid_: Won't fix, cancelled

**Testbed**:
The small real repo the den is pointed at once the den loop works. Friction found there drives pipeline changes and new den elements.
_Avoid_: Demo repo, sandbox

**Claim**:
The exclusive lock an agent takes on a ticket before working it.

**Handoff**:
The short document an agent writes at the end of its work so the next agent can continue without its conversation.
_Avoid_: Summary, progress note

**Delivery**:
The bridge's job that takes one ticket from a developer's commit, through an independent qa verify and the checks, to a merged pull request (ADR 0024). Starting one in the den is the user's approval of that path for the ticket. A delivery step's agent writes nothing on the board and pushes nothing; the bridge does both.
_Avoid_: Relay (the terminal's hop sequence), pipeline

## Control

**Pass gate**:
A point where an agent must stop and get the user's explicit approval.
_Avoid_: Checkpoint, approval step

**Gate request**:
The user's approve or reject on a pass gate, made in the UI and recorded as one line in `.scratch/_requests/requests.jsonl`. The line is an audit record and proves nothing about who wrote it; it runs nothing. The orchestrator reads it, acts, and marks it handled. An agent starts from the UI only through a token-authenticated dispatch (a steering command), never because a line appeared.
_Avoid_: Command, action (for a gate request; see steering command)

**Steering command**:
A UI-originated action on a live agent (dispatch, answer a permission request, send a message, kill) that the bridge executes and logs. It is authorized only by the UI's per-run token, never by a line in a file.
_Avoid_: Command (alone), gate request (a gate request only records and runs nothing)

**Permission request**:
A live agent asking to use a tool, held by the bridge until the user allows or denies it in the UI, where it appears under Needs you beside the pass gates. No answer, or an expired one, means deny. Allow is possible only after the full tool input has been shown.

**Autonomy**:
How many pass gates apply: supervised, gated, or autopilot. It is set per org, team, or agent.

**Hand off and exit**:
An agent ending on purpose once its ticket is done, it is blocked, or its context grows long.
_Avoid_: Apoptosis (the old name, ADR 0028), shutdown, kill (kill is the user force-stopping an agent)

**Org limits**:
The org-wide caps on concurrent agents and plan usage.
_Avoid_: Endocrine limits (the old name, ADR 0028), rate limiting, quotas

**Minimum tier**:
The lowest model a role may run on. It is the agent's role definition model, except qa light verify, whose minimum is haiku. A Jev pick can raise a tier above the minimum, never lower it.
_Avoid_: Floor model, base tier

**Verify depth**:
How hard qa verify looks at a developer's branch: `light` (run the tests, check the acceptance criteria) or `full`.
_Avoid_: Review level

**Shadow mode**:
Jev's picks are logged next to what actually ran and never applied. A use case no longer needs its own shadow run before going live; it runs a **Trial** (ADR 0010 Amendment 1).
_Avoid_: Dry run

**Trial**:
A use case's first live run: 10 resolved tickets on which it fired, then one keep-or-kill verdict from the user, judged on outcomes (weighted tokens per ticket and bounces against the 10 tickets before go-live), not on agreement with the orchestrator (ADR 0019).
_Avoid_: Shadow run, pilot

**Use case**:
One thing Jev is allowed to do, listed in `docs/jev-usecases.md` with its mode, inputs, measure, baseline, kill condition and confidence floor.
_Avoid_: Point, feature

**Label set**:
The fixed options Jev picks among for one use case (for example `small | standard | hard | other`). Jev never answers outside it.
_Avoid_: Enum, categories

**Safety miss**:
The event, defined per use case, that turns the use case off at once (for example an escaped bug after a light verify, or a Haiku developer that bounces).
_Avoid_: Failure, incident

**Advisory mode**:
A use case's output is shown to the orchestrator or the user but applied to nothing.
_Avoid_: Display-only, suggestion mode

**Config row**:
The `kind:"config"` row in `usage.jsonl` that sets a use case's mode and confidence floor and freezes its baseline. Appending one is how a use case goes live, is kept, is killed or rolls back.
_Avoid_: Settings, flag

**Wake-up gate**:
The check at orchestrator session start that decides whether new board input needs Claude at all. Code wakes on a fixed list (any user-authored comment first); Jev may suppress only an `informational` input.
_Avoid_: Wake filter, prelude

**Reserved budget**:
The per-session API spend ceiling for Jev calls, split among use cases (ADR 0015 decision 7).
_Avoid_: Quota, cap (the cap is the limit; the reserved budget is the split)

**Mod**:
A Claude Code plugin of function hooks that draws a band, status line or toast, or guards a tool call, inside a `claude` session. Ours are project-scope; third-party mods are reviewed first and may only be read-only bands.
_Avoid_: Extension, add-on

**Mod trial**:
A mod's first live run: 3 orchestrator sessions, then one keep-or-drop verdict from the user, recorded as one board line (what it caught, what it got wrong, its token and latency cost). Not a Jev **Trial**.
_Avoid_: Pilot

**Connection**:
A Model Context Protocol server listed in the den's catalog (`apps/bridge/library/connections.json`, ADR 0025): a remote service or a script in the den that gives an agent extra tools. The catalog names its purpose, its roles, who holds its credential and what each tool does (read, change, publish). An agent is started only with the connections the catalog and its role file both name.
_Avoid_: Plugin, integration, MCP (alone, for one entry)

**Library**:
What the den shows of connections and skills together, each named by its kind: a connection supplies tools, a skill is a written procedure and supplies none.
_Avoid_: Marketplace, catalog (the catalog is the file of connections only)

## Observation

**Telemetry**:
Aggregates derived from the org's own transcripts: tokens, tool calls, and errors, attributed to role and ticket. It can always be rebuilt from the transcripts.
_Avoid_: Logs, analytics (the **Metrics** view is where telemetry is shown)

**Metrics**:
The Den view that shows telemetry and the board's usage log as charts, in tabs: Efficiency, Quality, Economics and Jev. The kanban is a separate tab in the same panel.
_Avoid_: Dashboard (legacy slug of the crew-dashboard feature, which is the role-card **crew** view)

**Error cluster**:
A group of tool errors that share one normalized signature (paths, numbers, hashes and positions stripped), grouped by tool.
_Avoid_: Error bucket, error type

**Savings proposal**:
A suggested change that cuts token use at a telemetry hotspot, such as an index, a helper script, or delegating to scout. It becomes a ticket only after the user approves it.
_Avoid_: Optimization, recommendation

## Communication

**Herald**:
The role that drafts public posts about the org and what it builds. It writes a draft and never publishes.
_Avoid_: Marketer, publisher, PR bot

**Draft**:
One herald output, 1 to 3 paragraphs plus a source header, for the user to edit and post. A post is what the user publishes.
_Avoid_: Article

**Post series**:
An ordered set of related drafts, such as the first four.
_Avoid_: Campaign

## Crew and meetings

**Crew**:
The view listing every role as a role card. It is the same data as the den and the Board, never a copy.
_Avoid_: Roster (the den's list of live pandas), team page

**Role card**:
One role in the Crew view: team, nickname, responsibility, triggers, last run, totals, and Details and Talk buttons. Details opens the recipe card.
_Avoid_: Profile, agent card

**Outcome**:
How an agent's run ends: `done`, `noop` (nothing to do, with a reason), `clarify` (a question for the user, shown under Needs you), `blocked` or `failed`. It is recorded in the handoff State block.
_Avoid_: Result, status (status is the ticket's)

**Meeting**:
A ticket-scoped, bounded gathering of up to six agents on one topic, run in sequence, ending in a decision brief. The bridge runs it as a job and writes its files on the board. A topic with no ticket gets a discussion ticket, which is work for nobody. It can be rejoined with a follow-up for 24 hours after a decision or a close. See ADR 0017.
_Avoid_: Swarm, standup, chat

**Take**:
One participant's short answer in a meeting: claim, evidence, confidence, what it would keep or change, and at most one question for the user. A role may decline instead, with a reason. No role reads another role's take; only the chair does.
_Avoid_: Opinion, vote

**Decision brief**:
The chair's artifact: the question, two or three options with one recommended, the benefit, cost and task count of each, and what only the user can answer. It appears under Needs you and authorizes nothing. The option the user chooses becomes proposed work: a ticket that waits for the user's approval.
_Avoid_: Report, summary (the summary is kept after 24 hours)

**Chair**:
The agent that writes a meeting's decision brief from the takes: Bao (the orchestrator), on Bao's own slot. An architect chair for design questions is in ADR 0017 and is not built.
_Avoid_: Host, moderator

## UI names

What each term is called in anything a user sees (UI copy, labels, `aria-label`s, the design system). The terms above stay the names in code, role definitions and skills. The full list is the design system's Glossary.

| Term | UI name |
|---|---|
| Org | the den |
| Team | team (The Pass, Steamers, Tea, Pantry, Front of House, Cubs) |
| Agent | panda |
| Walk mode | enter the den |
| Role | role |
| Role definition | recipe card |
| Hand off and exit | clocking out |
| Org limits | plan usage, kitchen limits |
| Pass gate, gate request, permission request | Needs you |
| Crew | the Crew |
| Role card | role card |
| Meeting | round table (candidate; the design session decides) |
| Decision brief | decision brief |
