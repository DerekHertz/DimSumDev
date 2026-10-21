# Hierarchy audit replay

A read-only replay of one run's event log in the den: the tree as agents started (one owner, Bao or Jiao; up to four managers; up to four runners each), work handed down and results handed back up, and where the time went. The log is the record; the animation is a view of it. Playing, seeking and inspecting fold a prefix of recorded events and nothing else. They start no agent, make no bridge request and change no run.

Open it from **Work → Replay a run's hierarchy**, or with `?replay=<id>` on the den's address (`sample`, `team-and-den-ux-50`). Design reference: the approved prototype (`hierarchy-audit-replay.html`, Codex task-3).

| File | Job |
| --- | --- |
| `apps/ui/src/audit/replay-core.mjs` | The contract check, the fold to state at a cursor, the time buckets, the exports. Pure. |
| `apps/ui/src/audit/AuditReplay.jsx`, `audit.css` | The sheet: tree, playback, timeline, inspector, event log, exports. |
| `apps/ui/src/audit/sample-run.mjs` | The illustrative sample. Always labelled as one. |
| `apps/ui/src/audit/runs/` | Replays the den opens by name, including one recorded run. |
| `scripts/hierarchy-replay-export.mjs` | Derives a replay from the board's event log (the interim producer). |

## Event contract (schema version 1)

These are the prototype's field names, plus three optional fields. A file is a JSON object `{ schemaVersion: 1, runId, label, illustrative, source?, events }`, at most 1 MiB and 2000 events. `source` is `{ kind, description }` and says where the events came from.

Each event must have all of these fields, using an explicit `null` where a value is unknown: `runId, eventId, sequence, timestamp, agentId, parentId, name, role, layer, runtime, model, tier, kind, taskSummary, relatedAgentId, reason, blockedOn, commit, pr, evidenceRefs`. The optional fields are:

- `attempt` (1-99, default 1). A restart is a new `started` event with a higher attempt on the same `agentId`. Events from an older attempt are refused, so work is never counted twice.
- `verdict` (`pass`, `bounce` or `null`) on a `review` event. A bounce counts against the agent named in `relatedAgentId`.
- `sourceRef` (`{ log, seq }`): the producer's own identity for the record this event came from, such as a board row's `seq`. An inspected event can be checked against its source with it.

`kind` is one of `queued, started, delegated, working, waiting, blocked, awaiting, result, review, rework, accepted, failed, cancelled, completed`:

- `result` means execution is done and the work is handed back.
- `accepted` means the parent took a child's result (with `relatedAgentId` set).
- `completed` means the owner finished the task. Only the owner may send it.
- `awaiting` covers approval or review gates. `reason` says which.

Field limits, ID syntax, the owner rule (`Bao`, `Jiao`, or `null` when not recorded), the commit and PR formats and the evidence allow-list are the prototype's. Evidence links must be GitHub blob, commit, pull or actions URLs. A relative path is shown as text and never fetched.

### How the viewer handles a log

| Case | Handling |
| --- | --- |
| Not JSON, over the size limit, unknown schema version, unknown field, unsafe ID, string or URL | The whole file is refused. Nothing from it is shown, and the previous replay stays on screen. |
| Credential-like text | Replaced with `[credential removed]` and listed as a note. An ID that looks like a credential refuses the file. The matching is best effort, covering common token shapes, so producers must still redact before emitting. |
| Exact duplicate | Dropped and counted once (an info note). |
| Same ID or sequence with different content | The later copy is dropped (a warning). |
| Arrived after events with higher sequence numbers | Placed by sequence, flagged `late`. |
| Missing sequence numbers | Warning. Each agent's interval that spans the gap is unknown until that agent's next recorded state event. The run is incomplete. |
| Timestamp earlier than the event before it | Warning. The interval it closes is unknown, never negative. |
| More than 4 managers, or 4 runners under one manager | Shown with an over-limit badge and a warning. Not refused. |
| An event that cannot apply (no start, changed identity, an old attempt, after a terminal state without a restart) | Kept in the log, left out of the fold, listed. |

### How times are derived

An agent's state changes only on its own recorded state events. Each interval runs from one state event to that agent's next one, or to the cursor:

- Working: working, review and rework.
- Waiting: waiting, blocked, queued and awaiting.
- Handed back: from a result until it is accepted.
- Unknown: after `started`, after an owner's `result`, across any gap (for every agent), and over an interval closed by a backwards timestamp.

No clock is read, nothing is inferred from a quiet agent, and nothing is counted after the last event. Agent times overlap across parallel branches. For the task as a whole:

- **Someone working** is the union of all working intervals.
- **Waiting, nobody working** is recorded waiting outside those intervals.
- **Neither recorded** is the rest of the span: handoff gaps and unknown states.

No critical path is claimed. A log with no terminal owner state, or with gaps, is marked incomplete.

## Producers

**Interim: the board's event log.** `node scripts/hierarchy-replay-export.mjs <feature/ticket> [--owner Bao|Jiao] [--pr URL] [--out file]` reads `.scratch/events.jsonl` (and `.scratch/usage.jsonl` for models), from `DEN_ROOT` or the current directory, and writes one replay. It maps the log as follows:

- The owner starts at the ticket's first row. Orchestrator claims and releases are the owner's.
- Every other role is a manager. A role's second claim is a new attempt. A developer's next turn is `rework` only after a recorded `bounce` verdict; otherwise it is `working` (for example, a fix after a CI diagnosis, which the board records without a verdict).
- A comment with a verdict becomes a `review` event. It carries the first commit ID the comment cites (7-12 or 40 hex characters) and its handoff paths.
- A release becomes a `result`, or `blocked` if it was released as blocked. An owner's release is a `result` (its state unknown afterwards), because the board reuses `in-review` for the next role's turn and does not record an approval gate as such.
- A park becomes `blocked` with the park's reason, which is a short field the user writes, with credential-like text removed. A close becomes `cancelled`, and a resolve `completed`.

Comment text is never copied. The board does not record the owner's name, approval gates, wait reasons other than park reasons, runner leaves, or models for runs outside the bridge. Those fields stay `null` or unknown.

**Target: the runtime's tree events.** The owner → manager → runner runtime (codex-residents/07 to 11, the Codex track) should emit this contract directly. Its records should come from one serialized writer per run, assigning `sequence` and `eventId`. Each `started` event should carry the real runtime and model. A restart should be a new `attempt`, a review a `review` with a `verdict`, and a child result its parent's `accepted`. A wait should carry its `reason` and `blockedOn` when they are known. `sourceRef` should point at the runtime's own record. The integration point is `validateRun(value)`, and nothing on the viewer side needs to change. This replay never schedules, routes, admits or approves anything. Those jobs stay with the runtime and the bridge.

## Gaps

- **Producer.** No runtime emits tree events yet. Today's relays are flat: the recorded run shows six managers directly under the owner and no runners, so it carries two over-limit warnings. Replaying a real tree needs codex-residents/07 or later.
- **Storage and sharing.** The den opens replays bundled in `apps/ui/src/audit/runs/` and local files. Opening a saved replay from the board (`.scratch/<feature>/replays/`) by a stable link needs a bridge read route (for example `GET /replays/:id`, a GET-only row in `routes.mjs`). That is bridge work, which the user merges. Until then, a PR links a bundled replay by name, or attaches an exported file.
- **Provenance.** The viewer checks structure, not who wrote the log. Animation is not proof, and the log is not tamper-proof.
