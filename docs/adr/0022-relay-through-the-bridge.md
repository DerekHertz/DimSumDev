# A ticket's relay runs through the bridge: a pure hop planner, the next hop as the den's default, a finish event that advances the relay, and ceilings for the five roles that have none

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** accepted (user, 2026-10-12, for organism-infra/229). The user answered the seven decisions at the end; each answer is recorded there. It amends ADR 0016 decision 3 (the relay-hop 409, "Slice 3") and builds the relay runner that ADR 0019 decision 3 placed in `apps/bridge/relay/`. It leans on ADR 0021 (decisions 3, 7, 8, 10, 11, 12) and changes none of them. No code in this ticket.

**Context.** The user (2026-10-12, at the visual verdict on organism-infra/228) asked for two things: "dispatch the agent needed for a task directly ... the default in the drop down was the first agent needed", and "after completing the task it should trigger some event that wakes up orchestrator/bao and then it can be routed to the next task and so on". They also asked whether they will stop approving every request. Facts from the code (read 2026-10-12):

- `POST /agents` refuses `developer`, `qa` and `security` with 409; the den's Role select never offers them (`apps/ui/src/overlay/run-model.mjs` `ROLE_OPTIONS`). `POST /tasks` can start any role, but on a ticket it writes itself, so it cannot continue an existing ticket's relay.
- The hop logic is in three places that are not callable together: the orchestrator genome's prose (`.claude/agents/orchestrator.md`, "Code relay"), `scripts/dispatch-prompt.mjs` (a `SPECS` table of each cell and mode: branch or detached, release flag, context line, next handoff name, the light or full verify line), and `scripts/jev.mjs` (`tier`, `verify`, `route`; `tier` is in shadow and equals today's rule, ADR 0019 decision 5).
- The host already has the internal `start()` entry that skips the relay-hop refusal, builds a worktree per agent (detached, ADR 0021 amendment 2), and writes an `end` row when an agent finishes (`watch()` in `apps/bridge/cells/host.mjs`). Nothing reads that row. `workspaces.publish` creates the agent's branch at its final commit, so the bridge, not the agent, knows each hop's end sha.
- Ceilings (`apps/bridge/cells/ceilings.json`) exist for scout, developer, qa, security only. A role with none runs with no wall and asks for each write.

## Decision

### 1. Direct dispatch of a relay hop: one pure planner, the host starts what it plans

A new module `apps/bridge/relay/plan.mjs` exports one pure function:

```
nextHop(facts) -> { hop: { role, mode?, base, branch, detach, model, release, handoff }, why }
               |  { stop: { kind, reason } }
facts = { ticket: { ref, type, status, holder }, handoffs: [{ name, cell, mode, state }], verdicts: [...],
          ends: [{ role, mode, state, branch, sha }], bounces, risk?: "clean" | "hit" | null, usage }
```

It decides and names; it starts nothing and reads nothing. A thin `readFacts(ref)` beside it assembles `facts` from the board service (status, type, holder, handoffs and their State blocks, the verdicts the board's bounce count reads) and from the bridge's own `sessions.jsonl` `end` rows. **The base commit and branch come from the `end` rows, never from handoff text**: handoffs are written by agents, and `end` rows are the bridge's own record (the same trust line as ADR 0016 decision 6.9). `workspaces.publish` is extended so the `end` row carries `sha` and `branch`.

The hop table (`SPECS` in `dispatch-prompt.mjs`: style, release, context, handoff stem) moves into a data module that both `dispatch-prompt.mjs` and `plan.mjs` import, so a terminal-driven relay and the bridge cannot drift. Hop rules, in order (a stop is returned the first time one applies):

| State of the ticket | Next hop |
|---|---|
| frontier, code type (feature, bug, chore) | `developer` on a new branch at main `HEAD` (slim, ADR 0019 decision 4; see user decision 3) |
| developer ended `in-review`, no verdict | `qa` `verify` (light; full if the saved test run is red or a risk marker is set), detached at the developer's sha |
| qa verdict pass | the bridge runs `npm run risk-check` itself on the branch (a script, no agent): clean ends the relay at "ready to merge"; a hit, or the diff touching a guardrail path, starts `security` detached |
| security pass | "ready to merge" |
| qa or security bounce | `developer` again on the same branch with the findings (a fix round) |
| the second bounce on one ticket | stop: "failed twice" |
| a hop ended partial (State `pending` owned by the same role, context stop) | the same role and mode on the same branch, once; a second partial stops |

Non-code types keep ADR 0016 amendment 14's defaults (design-question: architect; spec: product; ui or asset: designer). `designer` and `product` are interactive (AskUserQuestion) and a headless child cannot ask, so they are never auto-advanced into or out of; the planner returns a stop `needs-you` for them. The planner takes no input from Jev in slice 1: `tier` is in shadow and equals the rule above, and `verify` depth follows the table. Jev wiring is a later slice, behind the same function (the `model` and verify-depth fields are where it plugs in).

**The route.** `POST /agents` keeps its body `{ ref, role, mode? }` and the 409 for relay-hop roles, with one exception: the host runs `nextHop` for the ref and starts the hop only when `role` and `mode` equal the plan's. Otherwise 409 "the next hop for this ticket is <role> <mode>". The client chooses nothing that reaches argv, the prompt, a base commit or a branch (ADR 0016 decision 6 holds). Eligibility for a hop is "the ticket has a relay state and no live agent", not "in the frontier": after the first hop the ticket is `in-review` and not on the frontier. Capacity, the 90% usage refusal, the double-click atomicity and the worktree-per-agent rule apply unchanged, through the same synchronous reservation. The hop prompt is a fixed template over the validated plan fields (role, mode, ticket ref, the handoff name to write, the release flag), as `promptFor` is today.

*Alternatives considered.* (a) Lift the 409 and let the client pass `base`, `branch`, `mode`: rejected, it puts client strings into argv-adjacent values and makes the UI the relay's state machine. (b) Have the bridge shell out to `dispatch-prompt.mjs`: rejected as the permanent shape, because the planner needs structured output and tests, not stdout text; the script stays for terminal use and imports the shared table. (c) Keep the 409 and have the user start the orchestrator for every relay: the status quo, which is what the user is asking to leave.

### 2. The default role: the planner's answer, shown in the snapshot

The hub adds `relay: { "<ref>": { next, stop } }` to the snapshot (additive), computed with the same `nextHop`, so the select's default and the host's check cannot disagree (the same pattern as the `capacity` key). `defaultRole(ticket)` in `run-model.mjs` becomes: the ticket's `relay.next.role` when present, else today's type map. The Role select offers the planned hop's role (even a relay-hop role) plus the non-relay roles; it never offers `developer`, `qa` or `security` for a ticket whose plan is something else, so the 409 can only be reached by a stale snapshot, and the den shows the refusal text. A `qa` mode is shown beside the role ("qa, verify"); the mode comes from the plan, not from the select.

*Alternatives considered.* Ask Jev `route` for the default: rejected for slice 1; it is advisory, costs a model call per render, and the planner already has the answer deterministically. Decide the default in the UI from the type only (today): cannot know the relay state. Per-user setting: it is a function of the ticket, not a preference.

### 3. The finish event: bridge code decides, the orchestrator is woken only at a stop

`createHost` gains `onEnd(run)` beside `recordRun`, called after the `end` row and the ledger row are written (so a failing hook cannot undo the end). `apps/bridge/relay/runner.mjs`, `createRunner({ host, readFacts, riskCheck, policy })`, owns it: on a finish it recomputes `nextHop` for that ticket and, if the ticket's relay is **on**, starts the hop through `host.start()`; if the plan is a stop, or the start is refused (429 no room or usage, 5xx spawn failure), it records the stop and publishes it. Relay state per ticket is `off` (default), `on`, or `paused` with a reason, persisted as `relay` lines in `sessions.jsonl` (the file the host already replays), so a restarted bridge knows which tickets had a relay and starts nothing: it shows `paused: bridge restarted` until the user resumes. The runner holds no timer and polls nothing; a paused-for-capacity relay resumes on the next `end` event or a click.

Failed and partial hops. An agent that ends `failed` or `terminated` pauses the relay with kind `hop-failed` (a user stop is kind `user-stopped` and never auto-retries). An agent that ends `done` with no published handoff for its hop pauses as `no-handoff`. A partial return (decision 1's table) retries once. The runner never reruns a hop on its own after a bounce beyond the fix round in the table.

The wake. The user's words are that the finish "wakes up orchestrator/bao". Bao is the orchestrator's body in the den (ADR 0019 decision 6). The finish event reaches Bao as a snapshot change `relay` (`{ type: "relay", ref, relay }`) that the den renders on Bao and in Needs you; an Opus orchestrator session is started (ADR 0021 decision 8, a short session woken by an event) **only for a stop that needs judgment**: `needs-you` (a scope question in a handoff), `failed-twice`, `ready-to-merge`. The deterministic hops (developer to verify to risk-check to security) are the table above and need no model.

*Alternatives considered.* (A) Wake an Opus orchestrator at every finish to apply the table: rejected. A fresh session costs 23k to 26k tokens to start (ADR 0021 context) and a relay has four to six hops; the session would do what a table does, and its answer would vary run to run. (B) A standing orchestrator session that watches the board: rejected by ADR 0021 decision 8 (never standing). (C, chosen) Bridge code for the deterministic part, a woken session only at stops. It keeps the user's intent (the finish event is the trigger, Bao is where it shows) and ADR 0019 decision 3 ("the orchestrator wakes only for gates and for conversation").

### 4. What still stops for the user

Starting the relay on a ticket is the user's approval of it (a token-authenticated click in the den, "Run relay", as `Relay autonomy` in `organism-protocol` says the approval is the user's). After that the runner stops, with a `stop` item in Needs you:

| Stop | When |
|---|---|
| `needs-you` | a hop's handoff names the user as owner of pending work, a ticket goes `blocked`, an open scope question, or a `designer` or `product` hop (interactive) |
| `ready-for-human` | a UI or asset ticket after qa verify (the user's visual verdict) |
| `failed-twice` | the second bounce on one ticket |
| `usage` | admit refuses at five-hour usage 90 or more; the relay pauses and resumes on the user's click |
| `no-room` | capacity 429; resumes on the next `end` event |
| `hop-failed`, `no-handoff`, `user-stopped`, `bridge-restart` | as in decision 3 |
| `environment` | the runtime cannot spawn or the wall is unavailable |
| `ready-to-merge` | the last stop of this ADR: risk-check clean (or security passed). **PR and merge are not done by the bridge here**; they stay with the user or an orchestrator session until ADR 0021 step 4 and 6 (the bridge holds credentials and checks merge conditions itself). A diff touching a guardrail path is `ready-to-merge` with the flag "guardrail path: yours" (ADR 0021 decision 10) |

Permission requests a hop agent raises (a command outside the wall, a write outside the worktree, a host not on the list) still go to Needs you as today; the runner never answers one and never widens a grant.

### 5. Ceilings for the five roles with none

A ceiling is `{ write: "none" | "worktree", hosts: [] }` (ADR 0021 decision 3). Adding one to a role turns the wall on for it and, for `worktree`, allows Write and Edit inside its own worktree without asking. This is a security-relevant change and a guardrail path (the user's gate, ADR 0021 decision 10): the entries below are proposals, shipped as one reviewed ticket with the user's yes. Every role below keeps: no network (`hosts: []`), the four deny rules (`git push`, `gh pr create` and the rest of `denyRun`), the guardrail and CI path denies, the main `.git` ref denies, and a request for anything beyond.

| Role | Proposed ceiling | May do without asking | Still asks |
|---|---|---|---|
| architect | `worktree`, no hosts | read the project; write ADRs, docs, throwaway prototypes in its worktree; run shell commands inside the wall | any write outside the worktree, any network, `.claude/` and CI paths (denied; it writes a gated patch as today) |
| orchestrator | `none`, no hosts | read the project and the board; run read-only commands | every write: it has no code-write access (ADR 0021 decision 8); board writes are bridge calls (ADR 0021 step 4) |
| product | `worktree`, no hosts | read; write spec drafts in its worktree | the board (outside the worktree), any network; the questions it asks the user are not requests |
| designer | `worktree`, no hosts | read; write specs and static mockups in its worktree | the board, any network; `spec` mode is interactive and cannot run headless |
| herald | `none`, no hosts | read the repo | its draft file (outside the repo) stays a request on purpose: the user reads what leaves; it never publishes |

*Will the user stop approving every request?* Partly, and this ADR says where not to promise more. A den relay of developer, qa and security already has ceilings (ADR 0021 step 2), so inside the worktree they ask for nothing. The ceilings above remove the same class of request (file writes and shell commands inside the worktree) for architect, product and designer. What remains for every role is the board: claim, comment, handoff and release write `.scratch/` in the main checkout, outside the worktree and so outside the wall. Whether they arrive as requests or as refusals under the current spawn flags is **unproved**; the recorded live check of slice 1's third ticket counts requests and refusals by cause. Not widened here, and not proposed: a write grant on `<root>/.scratch/**` for hop roles (it would let an agent write any ticket or lock; see user decision 5), a network host for any of the five, and any grant to `herald` or `orchestrator` to write outside the worktree. The fix that removes board requests without widening a ceiling is ADR 0021 step 4, board calls as bridge calls; the runner in this ADR would call the board service in-process for its own reads and does not need it.

### 6. Slices

The smallest slice the user can use from the Den is slice 1: start the next hop of a ticket from the den, with the right default. Request 2 (the finish event) is slice 2.

- **Slice 1, hop planner and direct hop dispatch.** The shared hop table and `plan.mjs`; the `end` row carries `sha` and `branch`, the host creates a hop's worktree at a given base and the route admits the planned hop; the snapshot `relay` key and the select's default. The user runs each hop with a click; nothing advances by itself. Three tickets (drafted in the handoff).
- **Slice 2, the finish event.** `onEnd`, the runner, relay state in `sessions.jsonl`, "Run relay" (`on`) and the stop items in Needs you, the risk-check step, the live `relay` change frame. This shares one thing with organism-infra/230: the stop reason strings and the `relay` snapshot key, so 230's plain-words reason on an approval and this ADR's stop items read from one vocabulary; a Stop control on a running hop is the existing `POST /agents/:id/stop`, and a user stop sets the relay to `user-stopped`.
- **Slice 3, ceilings** for the five roles (the user's gate), then a live count of requests by cause in a den relay.
- **Later.** Jev `tier` and `verify` behind the planner's fields; the bridge opens the PR and merges (ADR 0021 steps 4 and 6); a tree with a barrier (ADR 0021 decision 16) is a runner over several `nextHop` calls and needs no change to the planner's interface.

## Considered options (designed twice)

- *Design A (chosen). A pure planner plus a thin runner and host change.* The planner is the deep module: a small interface (`nextHop(facts)`), all the hop rules behind it, tested by one table of facts to hops. The seam is at the top: tests drive `startBridge` with the fake runtime and a fixture board and assert what the host started, plus a pure test of `nextHop`. Terminal dispatch and the bridge share one hop table, so the relay has one definition.
- *Design B. The bridge wakes an orchestrator session after every finish, and that session dispatches the next agent through bridge routes.* Smaller bridge code, but it keeps the relay as prose, re-reads the board each time at about 25k tokens a hop, varies run to run, and needs the orchestrator to hold start rights (a ceiling for the one role that is meant to have no write access). It also cannot be tested without a model. Rejected for the deterministic hops; kept for the stops (decision 3).
- *Design C. Auto-advance with no per-ticket switch.* Rejected: a relay is then started by a user's first click on any ticket, and a stray click spends a ticket's tokens. The per-ticket `on` is the approval.

## Consequences

- ADR 0016 decision 3's relay-hop 409 stays on the route and gains one exception (the planned hop), so slice 3 of ADR 0016 is built as this ADR's slices 1 and 2. ADR 0016 is not edited by this ticket; the amendment is the user's to accept with this ADR.
- `dispatch-prompt.mjs` imports the hop table; a terminal relay and the bridge's agree by construction.
- The `end` row grows `sha` and `branch`; replay already ignores unknown fields on the `end` row, but the host's replay check is a test in slice 1.
- Nothing in this ADR adds an agent, a standing session, a credential or a network host. The bridge starts agents it already can; the new thing is that it picks which, from the board.
- `CONTEXT.md` has no term for a hop or the relay's state. Proposed (the user's to accept): **Relay hop** (one agent run of a ticket's relay, planned from the board) and **Relay stop** (a reason the relay waits for the user).

## Decisions for the user

1. **Who decides the next hop when an agent finishes?** (a) Bridge code for the deterministic hops, an orchestrator session woken only at a stop (recommended). (b) An Opus orchestrator session woken at every finish, as you described. (c) Bridge code only, no orchestrator wake at all.
2. **Does the relay advance by itself?** (a) Slice 1: each hop is a click; slice 2 adds a per-ticket "Run relay" switch that advances the deterministic hops and is your approval (recommended). (b) Always click per hop. (c) Auto-advance on every ticket you start.
3. **First hop of a code ticket.** (a) `developer` test-first, per ADR 0019 decision 4 (recommended). (b) `qa` `specify` first, per CLAUDE.md today. (c) `developer` unless the ticket carries a risk marker, then `qa` `specify`.
4. **Ceilings for architect, orchestrator, product, designer, herald** as in the table. (a) Accept as proposed (recommended; it is your guardrail gate, so accepting means a reviewed ticket). (b) Widen one (name it). (c) Only architect for now.
5. **Board writes by hop agents** (claim, comment, handoff, release, outside the wall). (a) Keep asking, measure in the first live den relay, decide with numbers (recommended). (b) Grant hop roles a write on `<root>/.scratch/**`. (c) Build bridge-held board calls (ADR 0021 step 4) before the relay.
6. **Where the relay ends.** (a) At "ready to merge"; PR and merge stay with you or an orchestrator session until ADR 0021 steps 4 and 6 exist (recommended). (b) The bridge opens the PR but you merge. (c) Wait for the full step 4 and 6 first.
7. **Interactive roles** (`designer` spec, `product` grilling). (a) Never auto-advanced; the relay stops for them (recommended). (b) Run them headless and let the agent put its questions in a handoff.

**The user's answers (2026-10-12, recorded by the orchestrator).** The user took option (a) on all seven:
1. Bridge code decides the deterministic hops; an orchestrator session is woken only at a stop.
2. Slice 1 is a click per hop; slice 2 adds the per-ticket "Run relay" switch, which is the user's approval.
3. The first hop of a code ticket started from the den is `developer`, test-first (ADR 0019 decision 4). The question was asked about den-started relays; the terminal relay in `CLAUDE.md` and the orchestrator genome is not changed by this answer.
4. The ceilings table is accepted as proposed. It still ships as one reviewed ticket (slice 3, a guardrail path).
5. Board writes by hop agents keep asking; the first live den relay counts them and the user decides with numbers.
6. The relay ends at "ready to merge"; PR and merge stay with the user or an orchestrator session.
7. Interactive roles (`designer` spec, `product`) are never auto-advanced; the relay stops for them.
