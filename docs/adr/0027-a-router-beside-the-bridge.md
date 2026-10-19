# A router beside the bridge starts approved work in order

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** proposed. The user accepts it by merging its PR. It amends the den MVP spec's out-of-scope line on unattended queue operation (below). It narrows the station-inboxes brief (`docs/research/station-inboxes-grill-brief-2026-10-17.md`) to its first question: full inboxes wait for evidence.

**Context.** On 2026-10-17 a terminal orchestrator, run as a subagent, dispatched qa cells in the background and ended. Their reports came back to the main session, which then had to route the relay by hand (friction F42). The user's rule: the terminal session is a temporary executive session, and the agentic system must work without it. Deliver (ADR 0024) already runs one ticket end to end inside the bridge, but it moves only when a run ends or the user clicks. Nothing picks the next ticket, and a bridge restart leaves every delivery paused as `bridge-restart` until someone resumes it. The work order exists only as prose (`.scratch/den-mvp/order-2026-10-17.md`), and the queue cannot express it.

Every choice below was put to the user in a grilling session on 2026-10-17 and is their answer.

## Decision

1. **A router, in its own process.** A small router runs as its own systemd user unit beside the bridge. `den:install` installs it outside any release folder, as 77's launcher is installed, so a deployment that restarts or drains the bridge does not stop routing. A change to the router takes effect when the user runs `den:install` again. It does not update itself.
2. **A thin client of the bridge.** The router starts and resumes deliveries through the bridge's existing routes (`POST /deliveries`, `/deliveries/:id/resume`) and follows `GET /events`. The bridge keeps cells, the wall, resource groups and capacity. The router never starts a cell. It authenticates with a service token that `den:install` writes, outside the four-session login cap.
3. **Authorization.** A ticket at `ready-for-agent` plus its place in the work order is the user's approval to deliver it. The existing stops stay: a user verdict, an open scope question, a twice-failed ticket, an environment problem, 5-hour usage at 90% or more, a red or conflicted merge, and a change to the bridge, a guardrail or CI, which the user merges.
4. **The work order is a file.** It is one structured file the router reads: an ordered list of ticket refs, each with optional `not-beside` notes, with the prose rationale under it. The user edits it, or an executive session acting on the user's word. Bao may propose a change, which reaches the user as a decision. The router never reorders.
5. **Pairing.** The router fills up to `max_concurrent_cells` from the top of the order. A ticket starts beside a running one only if their files do not overlap (the `scripts/batch-groups.mjs` logic). A `not-beside` note overrides that.
6. **Stateless.** The router keeps no state of its own. On each `/events` change, and at start, it recomputes what to do from the order file, the board and the bridge's `/state`. Losing the router loses nothing. If the bridge is down for about ten minutes, the router reports it once as an environment stop.
7. **Usage.** The router reads usage itself, live, through `scripts/usage.mjs` with a no-cache read (organism-infra/234). It does not trust a cached figure (F19, F44). At 90% or more it starts nothing new.
8. **What it may resume.** It may resume three pauses: `bridge-restart`; a usage pause, once the window has reset; and no-room, once a slot frees. Every other pause is the user's.
9. **Stops reach the user twice.** A stop is written to the board, so the den shows it under Needs you, and is sent as a phone push.
10. **Hand starts stay.** The user, Bao or an executive session may still start a delivery. The bridge counts capacity, and the router skips any ticket that already has a delivery or a claim.
11. **qa `specify`.** Deliver does not gain a `specify` step; den-mvp/71 decides whether the relay keeps it. `start` takes an optional `from` branch, so tests written ahead of time are the delivery's base.

## Spec amendment

The den MVP spec ("Out of Scope") listed "automatic restart/usage recovery, unattended queue operation" as following evidence from daily use. F42 is that evidence. Unattended running of approved work, in the order the user set, is now in scope, within decision 3. Running work nobody approved, and building around the clock, stay out of scope.

## Slices

1. Router slice 1: the unit and token from `den:install`, the order file format, starting the next ticket when a slot frees, resuming `bridge-restart`, and the live usage check (with organism-infra/234).
2. The usage and no-room resumes, and the phone push.
3. `from` on `POST /deliveries`.
4. Pairing by file overlap, and `not-beside`.

The evidence for full station inboxes (lanes, joins, backpressure) is a week of the router in daily use.

## Consequences

- The router's process is outside a release, so its code reaches the machine only through `den:install`, like the launcher's.
- The service token is a second credential for the bridge's write routes. Security reviews slice 1.
- An executive session no longer routes. It plans, edits the order and the board, and runs a grilling session or a one-off.
