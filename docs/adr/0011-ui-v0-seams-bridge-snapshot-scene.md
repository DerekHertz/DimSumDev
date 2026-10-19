# UI v0 has three seams: the bridge HTTP/SSE surface, the metrics JSON, and scene-from-state; it is a React and Vite app that a localhost bridge serves

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** accepted (user, 2026-09-29; dependencies in decision 9 approved; dispatch gate derived from Board state).

**Context.** `.scratch/dimsumden-ui-v0/spec.md` asks for a live 3D scene plus a control panel, fed by a thin Node bridge that watches the Board. It names three test seams and leaves their shapes open, along with the app layout and whether metrics ride in the snapshot. Tickets 02 to 13 build against whatever this ADR fixes, so the shapes below are written to be tested against literally. Facts found while designing:

- The repo is plain `.mjs` run by `node --test`, with no TypeScript, bundler or Vitest. `apps/ui/src/scene/dev-scene.html` loads `three` from a CDN importmap. ADR 0007 mentions Vitest and a `daemon/` directory; neither exists.
- `board-service.mjs` `list()` returns only `{feature, ticket, status}` and has no `subscribe`. The bridge needs richer reads than the board service offers, so it parses the Board itself. That is allowed (spec story 4: the bridge reads, and writes only through `board`).
- In v0 no button runs a board action: the gate buttons only append a Gate request. The spec's "board actions go through the `board` CLI" is therefore a constraint on future work, not a v0 feature. The bridge has zero Board write paths.
- The claim lock file is `<cell-type> <ISO ts>` (one line). `events.jsonl` rows carry `feature`, `ticket`, `cell`, `op` and `ts`. `usage.jsonl` rows are discriminated by `kind` (`usage`, `cell`, `resolved`, `incident`, and others).

**Decision.**

### 1. Layout and ownership

```
apps/bridge/          Node bridge: server.mjs (startBridge), board-reader.mjs, snapshot.mjs (pure),
                      watch.mjs, requests-log.mjs (shared with scripts/requests.mjs)
apps/ui/              React + R3F app built by Vite; pure logic lives in .mjs files beside the .jsx
apps/organism-infra/priority.mjs   ticket 02 (pure)
scripts/metrics.mjs   ticket 03: exports computeMetrics(); CLI wrapper prints it
scripts/requests.mjs  ticket 06: --list, --handle; orchestrator-facing
```

The bridge is a new app rather than the ADR 0007 `daemon/`. When organism-infra/03's daemon arrives it replaces `apps/bridge` behind the same HTTP/SSE surface, and `daemon/` is then created. Imports between these directories are relative, as `dev-scene.mjs` already does for the director; no npm workspaces.

Test runner stays `node --test`. This amends the "plain Vitest" wording in ADR 0007 decision 1: the director's tests already run under `node --test`, and adding Vitest buys nothing.

### 2. Seam 1: the bridge is one deep module behind HTTP

`startBridge({ root, port = 4317, uiDir }) -> Promise<{ url, port, close() }>`. `root` is the main checkout (the directory holding `.scratch/`); the CLI resolves it with `resolveRoot` from `board-service.mjs`, and tests pass a temp dir. The host is fixed to `127.0.0.1` and is not configurable (story 5). `uiDir` defaults to `apps/ui/dist`. `port: 0` picks a free port for tests.

The whole test surface is this function plus HTTP. Board reading, snapshot building, diffing and watching are internal and get no tests of their own, except priority (ticket 02, whose table tests the spec requires) and the client reducer (decision 5).

Routes:

| Route | Behaviour |
|---|---|
| `GET /state` | 200, the snapshot (decision 3), `Cache-Control: no-store` |
| `GET /metrics` | 200, exactly the output of `computeMetrics` (decision 4) |
| `GET /events` | SSE stream (decision 5) |
| `POST /requests` | Append one Gate request (decision 6) |
| `GET /` and other paths | Static files from `uiDir`; unknown path serves `index.html`; path traversal is a 403 |

Hardening on every request: reject when the `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); on `POST`, require `Content-Type: application/json` and, when an `Origin` header is present, require it to equal `http://127.0.0.1:<port>` or `http://localhost:<port>` (a web page on another origin can otherwise fire a form POST at localhost and press a gate). Failures return 403 and write nothing.

Watching: `fs.watch(<root>/.scratch, { recursive: true })` (Node 22 supports this on Linux, Windows and macOS) triggers a debounced refresh (100 ms). A safety-net refresh runs every 2 s, because watchers miss events on some filesystems, notably WSL over `/mnt`. Both call the same `refresh()`, which rebuilds the snapshot, diffs it against the previous one, and emits change events. The 2 s net makes story 2's "about 2 seconds" a guarantee rather than a hope. Reading `events.jsonl` and `usage.jsonl` incrementally by byte offset is allowed but not required.

### 3. The snapshot (`GET /state`, and the SSE `snapshot` event)

Only non-resolved tickets appear. Keys are additive-only: later panels add keys, never rename or remove (spec, Further Notes). Unknown keys must be ignored by consumers.

```json
{
  "schema": 1,
  "seq": 42,
  "generatedAt": "2026-09-29T06:00:00.000Z",
  "sessions": 9,
  "tickets": [
    {
      "ref": "dimsumden-ui-v0/04-bridge-state",
      "feature": "dimsumden-ui-v0",
      "title": "Bridge: `GET /state` snapshot",
      "type": "feature",
      "status": "ready-for-agent",
      "ready": true,
      "priority": "P0",
      "effectivePriority": "P0",
      "bumps": 0,
      "bumped": false,
      "readySince": "2026-09-29T05:10:00.000Z",
      "blockedBy": [],
      "blockedReason": null,
      "holder": null,
      "lastCell": "orchestrator",
      "gate": "dispatch",
      "request": null,
      "handoff": null
    },
    {
      "ref": "organism-infra/28-review-claims-keep-in-review",
      "feature": "organism-infra",
      "title": "28: Review claims should not clobber in-review status",
      "type": "bug",
      "status": "in-review",
      "ready": false,
      "priority": "P2",
      "effectivePriority": "P2",
      "bumps": 0,
      "bumped": false,
      "readySince": null,
      "blockedBy": [],
      "blockedReason": null,
      "holder": null,
      "lastCell": "security",
      "gate": "merge",
      "request": { "id": "6f1c1b7e-0d55-4c3a-9b52-1f5d7e0a9a10", "kind": "merge-approve", "ts": "2026-09-29T05:58:00.000Z" },
      "handoff": {
        "path": "organism-infra/handoffs/28-security.md",
        "mtime": "2026-09-29T05:40:00.000Z",
        "truncated": false,
        "text": "## State\n..."
      }
    },
    {
      "ref": "dimsumden-ui-v0/07-ui-shell",
      "feature": "dimsumden-ui-v0",
      "title": "UI app shell: package, layout, live connection",
      "type": "feature",
      "status": "ready-for-agent",
      "ready": false,
      "priority": "P0",
      "effectivePriority": "P0",
      "bumps": 0,
      "bumped": false,
      "readySince": null,
      "blockedBy": [{ "ref": "dimsumden-ui-v0/05-bridge-events", "status": "ready-for-agent" }],
      "blockedReason": null,
      "holder": null,
      "lastCell": null,
      "gate": null,
      "request": null,
      "handoff": null
    }
  ],
  "frontier": ["dimsumden-ui-v0/04-bridge-state"],
  "usage": { "fiveHour": 74, "weekly": 72, "sampledAt": "2026-09-29T04:36:50.650Z" },
  "capacity": {
    "max": 8,
    "cap": 8,
    "load": 2,
    "live": 1,
    "room": 6,
    "refs": [
      { "ref": "dimsumden-ui-v0/04-bridge-state", "kind": "live" },
      { "ref": "organism-infra/28-review-claims-keep-in-review", "kind": "lock" }
    ]
  },
  "requests": [
    {
      "id": "6f1c1b7e-0d55-4c3a-9b52-1f5d7e0a9a10",
      "ts": "2026-09-29T05:58:00.000Z",
      "kind": "merge-approve",
      "ref": "organism-infra/28-review-claims-keep-in-review",
      "note": "ship it",
      "state": "pending"
    }
  ]
}
```

Field rules (each is a test target for ticket 04):

- `tickets` is sorted by `ref`. `ref` is `<feature>/<NN-slug>`, the file name without `.md`. `title` is the H1 text with the leading `NN:` kept as written. `type` is the first word of the `**Type:**` line, lower-cased (`feature`, `bug`, `design`, ...), or `null`.
- `status` is the ticket's `**Status:**` value verbatim (`ready-for-agent`, `claimed`, `in-review`, `blocked`, `ready-for-human`; `resolved` tickets are omitted).
- `ready` is `status == "ready-for-agent"` and every `Blocked by` entry is resolved. `blockedBy` lists only the unresolved blockers, each `{ref, status}` (`status: "unknown"` when the file is missing). Blocker tokens are `NN`, `feature/NN`, or `NN (note)`; a bare `NN` means the same feature; text such as "None" yields none.
- `frontier` is the refs of `ready` tickets with no claim lock, in the order ticket 02 produces (effective priority, then age, then number). Ticket 02's interface, which the snapshot builder calls: a pure function taking each candidate's `{ref, priority, readySince}` and the list of orchestrator handoff timestamps, returning `{ref, priority, effectivePriority, bumps, bumped}` in frontier order. `priority` is the parsed `P0` to `P3` (missing or malformed is `P2`). `readySince` is an opaque ISO string; the recommended source is the ticket's first board event at or after it became `ready-for-agent`, else the file mtime. `sessions` is the count of `.scratch/_handoffs/*-orchestrator-*.md` files. `bumped` is `bumps >= 1`; a P0 never bumps.
- `holder` is `{cell, since}` parsed from the claim lock, else `null`. `lastCell` is the `cell` of the ticket's newest row in `events.jsonl`, else `null`.
- `blockedReason` is the text of the ticket's last `## Comments` bullet when `status` is `blocked`, else `null`.
- `capacity` (added 2026-10-12, organism-infra/227; top-level, additive, still schema 1; added by the hub beside `agents`, not by `buildSnapshot`) is the output of `capacity()` in ADR 0016 amendment 14, built from the host's live agents, the tickets that hold a claim lock, and the host's effective limits: `max` (`max_concurrent_cells`, default 8) and `cap` (the session cap, 8), each already lowered by any policy override. `load` counts distinct refs that hold a live agent or a lock; `live` counts host agents; `room = max(0, min(max - load, cap - live))`; `refs` is one `{ ref, kind }` per ref that fills a slot, `kind` `"live"` for a host agent (including one that has claimed its own ticket) and `"lock"` for a claim lock held by a cell the host did not start. Ended agents and released locks do not count. It is also in the SSE `snapshot` frame; no new change frame carries it.
- `gate` is derived, never stored. `"merge"` when `status` is `in-review`, there is no claim lock, and the newest `--verdict` comment on the ticket is a `pass` from `security` (ADR 0008 decision 12 rows carry `verdict`). `"dispatch"` for `frontier[0]` only. Otherwise `null`. *(Amended 2026-10-12, organism-infra/154: the clause "and only when no ticket anywhere holds a claim lock" is gone. It rested on `max_concurrent_cells` being 1; the default `max_concurrent_cells` is now 8 (was 2 when this was written) and the den must reach every agent. The gate stays on one ticket, so Needs you shows one dispatch prompt rather than one per frontier ticket, and it moves to the next ticket as soon as the first is claimed. Whether a ticket may be started, and whether there is room, is no longer the gate's job: any `frontier` ref may be dispatched and the snapshot's top-level `capacity` object says whether there is room. Both are in ADR 0016 amendment 14. The `capacity` key is additive and is added by the hub with the agents, not by the board-only snapshot builder.)*
- `request` is the ticket's pending Gate request `{id, kind, ts}`, else `null`. It is the reason a button shows "pending" (story 22).
- `handoff` is the newest file (by mtime) in `<feature>/handoffs/` whose name starts with the ticket's `NN-`, with `path` relative to `.scratch/`, ISO `mtime`, and `text` capped at 8 KB (`truncated: true` when cut), else `null`.
- `usage` is the newest `kind:"usage"` row with a numeric `five_hour`, as `{fiveHour, weekly, sampledAt}`, else `null` (the panel shows "not sampled").
- `requests` holds every pending request and the 10 newest handled ones, oldest first. `state` is `"pending"` or `"handled"`; a handled request also carries `outcome` and `handledAt`.

### 4. Metrics ride outside the snapshot: `GET /metrics` and `metrics.mjs --json`

The snapshot carries only the latest `usage`; the charts data does not ride in it. Reasons: the metrics change on a different cadence (they read whole log files, the snapshot reads the Board), keeping them out holds the snapshot small and its shape stable, and one function backs both consumers. `scripts/metrics.mjs` exports `computeMetrics({ usageLines, eventLines })` (pure, over parsed rows, malformed lines already skipped) and the CLI prints its result as JSON; `GET /metrics` calls the same function, so the panel and `--json` cannot disagree (story 28). The SSE stream sends a payload-free `metrics-changed` event when `usage.jsonl` or `events.jsonl` changes; the client refetches `/metrics`.

```json
{
  "schema": 1,
  "throughput": {
    "windowHours": 5,
    "windows": [
      { "start": "2026-09-28T19:00:00.000Z", "resolved": 4 },
      { "start": "2026-09-29T00:00:00.000Z", "resolved": 0 },
      { "start": "2026-09-29T05:00:00.000Z", "resolved": 2 }
    ]
  },
  "tokensByCell": {
    "developer": { "tickets": 5, "tokens": 812345, "perTicket": 162469 },
    "qa": { "tickets": 5, "tokens": 400100, "perTicket": 80020 }
  },
  "resolvedTickets": 16,
  "incidentsByTool": {
    "board-claim": { "incidents": 3, "perTicket": 0.19 },
    "git": { "incidents": 2, "perTicket": 0.13 }
  },
  "usage": { "fiveHour": 74, "weekly": 72, "sampledAt": "2026-09-29T04:36:50.650Z" }
}
```

Rules for ticket 03:

- Windows are fixed 5-hour buckets aligned to the Unix epoch in UTC, from the first `kind:"resolved"` row's bucket to the last, gaps filled with `resolved: 0`, capped at the newest 24. No `resolved` rows gives `windows: []`, which the chart renders as an empty state (story 29).
- `tokensByCell[cell]`: `tokens` is the sum of `kind:"cell"` rows' `tokens` for tickets that have a `kind:"resolved"` row; `tickets` is how many such tickets that cell worked on; `perTicket` is `round(tokens / tickets)`. A cell with no such rows is absent, not zero.
- `incidentsByTool[tool]`: `incidents` counts `kind:"incident"` rows, with older free-text tools mapped onto the fixed list in `scripts/log-cell.mjs` (unmapped ones go under `"other"`); `perTicket` is `incidents / resolvedTickets` to two decimals; `resolvedTickets` is the count of `kind:"resolved"` rows and is `0` with no data (then `incidentsByTool` is `{}` and `perTicket` is not computed).
- `usage` matches the snapshot's `usage` (one shared reader).
- Text output without `--json` is free-form and not a contract. Bounce rate and Jev savings are deferred; they will be new keys.

### 5. SSE stream (`GET /events`) and the client reducer

Response is `text/event-stream`, `Cache-Control: no-store`. The first message on every connection is a full snapshot, so a page load or an `EventSource` auto-reconnect is always fresh (story 3); no `Last-Event-ID` handling. A `: ping` comment goes out every 15 s. If a client's socket back-pressures (`res.write` returns false and does not drain within 5 s), the bridge destroys it; the reconnect gets a fresh snapshot.

```
event: snapshot
data: {"schema":1,"seq":42, ...}

event: change
data: {"seq":43,"type":"ticket","ref":"dimsumden-ui-v0/04-bridge-state","ticket":{ ...full ticket... }}
```

`change` types (each carries `seq`, which increments by one per event on this bridge process and continues from the snapshot's `seq`):

| `type` | Payload | Client action |
|---|---|---|
| `ticket` | `ref`, `ticket` (full object, or `null` when it left the snapshot, e.g. resolved) | upsert or remove by `ref` |
| `frontier` | `refs: [...]` | replace `frontier` |
| `usage` | `usage` (object or `null`) | replace |
| `sessions` | `sessions: <int>` | replace |
| `requests` | `requests: [...]` | replace |
| `metrics-changed` | none | refetch `GET /metrics` |

Unknown `type` values are ignored. A `seq` that is not previous plus one means a missed event: the client discards its state and refetches `GET /state`. A ticket whose `effectivePriority` or `gate` changed produces a `ticket` event; a change in order alone produces `frontier`.

The client applies events with one pure reducer, `applyEvent(state, event) -> state`, in `apps/ui/src/state/apply-event.mjs`. Ticket 05 and 07 test it against the examples above. It is the client half of this seam.

### 6. `POST /requests` and the requests log

Request body: `{ "kind": "merge-approve", "ref": "organism-infra/28-review-claims-keep-in-review", "note": "optional" }`. The bridge assigns `id` (`crypto.randomUUID()`) and `ts`, and appends exactly one line to `.scratch/_requests/requests.jsonl` (creating the directory), then returns 201 with `{ "request": { id, ts, kind, ref, note? } }`.

Validation (any failure writes nothing): `kind` is one of `merge-approve`, `merge-reject`, `dispatch-approve`, `dispatch-reject` (400); `ref` names a ticket currently in the snapshot (404); the ticket's `gate` matches the kind (`merge-*` needs `gate == "merge"`, `dispatch-*` needs `gate == "dispatch"`) (409); no pending request already exists for that `ref` (409, story 22); `note`, if present, is a string of at most 500 characters (400); body at most 4 KB (413).

Handled marks are separate append-only lines in the same file, never edits: `{ "handled": "<id>", "ts": "...", "outcome": "merged" }`. A request is pending until a handled line names its id. `apps/bridge/requests-log.mjs` parses this file and is shared by the bridge and by `scripts/requests.mjs`, so the two cannot disagree on what "pending" means. Whether `_requests/` is git-ignored is left to the orchestrator; the design does not depend on it.

### 7. Seam 3: scene-from-state

`apps/ui/src/scene/scene-from-state.mjs`: `sceneFromState(snapshot) -> SceneCell[]`, pure, with no `three`, React or DOM import (so `node --test` runs it), following the style of `prop-placement.mjs`.

```json
[
  { "ref": "organism-infra/28-review-claims-keep-in-review", "cellType": "security", "status": "in-review", "perch": "knee#0", "pose": "waiting_on_user" },
  { "ref": "dimsumden-ui-v0/04-bridge-state", "cellType": "developer", "status": "ready-for-agent", "perch": "shoulder#0", "pose": "waiting_on_user" }
]
```

Rules (table-test targets for ticket 08):

- **Active set.** A ticket is active when its `status` is `claimed`, `in-review`, `blocked` or `ready-for-human`, or when its `ref` is in `frontier`. Anything else is excluded (a ticket that is ready but blocked by an unresolved dependency is not in the scene). Output order: active tickets by `ref`, then frontier tickets in frontier order, cut at `MAX_PLUSH = 12` (active tickets win the cap). Empty input yields `[]`; the renderer then draws Bao alone (story 11).
- **`cellType`** is `holder.cell`, else `lastCell`, else a default from `type`: `design`, `design-question`, `design-direction`, `decision` and `prototype` give `architect`; `research` gives `scout`; anything else gives `developer`.
- **`pose`** is one of the director's `STATES` (ADR 0007; `packages/character-director/src/director.mjs`), so nothing new is animated and the director keeps owning state-to-clip. Rule order: `gate` not null gives `waiting_on_user`; `status == "ready-for-human"` gives `waiting_on_user`; `claimed` gives `working`; `in-review` with a `holder` (a review is running) gives `working`; `in-review` without one gives `done`; `blocked` gives `blocked`; a frontier ticket gives `idle`.
- **`perch`** is `"<region>#<slot>"`. `region` comes from the station map in `design-brief.md` §4.2: orchestrator, product and architect give `crown`; developer, scout and debugger give `shoulder`; qa and security give `knee`; designer gives `grass`. `slot` is the 0-based index of the cell among output cells in that region, in output order. The renderer maps slots to anchors and spills past the anchor count to `grass`; perch anchors and travel stay in the character-animation tickets.
- `status` is copied through unchanged so the renderer can badge it.

The renderer feeds the director through a third `StateSource` adapter, `snapshotStateSource`, in `apps/ui` (alongside ADR 0007's mock and future daemon adapters): on each new `SceneCell[]` it diffs against the previous list and emits `{cell_id: ref, state: pose, ts}` for new or changed cells. Clicking a plush selects `ref` in the panel (story 10). A `SceneCell` list is all the renderer knows about the Board.

### 8. UI app layout and dev loop

- **Vite** builds `apps/ui` to `apps/ui/dist` (already git-ignored): `root: apps/ui`, `index.html` at `apps/ui/index.html`, `publicDir: apps/ui/public` (so `models/panda.glb` is served at `/models/panda.glb`), JSX handled by esbuild with `jsx: "automatic"` (no React plugin). `server.fs.allow` includes the repo root so `packages/character-director` and `apps/ui/src/assets/panda-contract.mjs` import relatively. The existing CDN-based `dev-scene.html` is untouched; the new app bundles `three` from `node_modules`.
- **JavaScript, not TypeScript**, with JSDoc where types help. That matches every existing file and avoids a compile step in `node --test`. `CLAUDE.md`'s "TypeScript monorepo (planned)" is aspirational; this ADR does not change `CLAUDE.md`, and moving to TypeScript later is a separate decision.
- **One file per pure concern, thin `.jsx`.** Anything with logic (`apply-event.mjs`, `scene-from-state.mjs`, panel view-models such as `queue-model.mjs`, chart scales, the markdown renderer) is `.mjs` and tested under `node --test`. Components only draw view-model output and are verified by the browser smoke. This is how "queue renders in priority order (test)" is met without adding jsdom or a testing-library.
- **Handoff markdown** is rendered by a small in-house parser (`render-markdown.mjs`: headings, lists, fenced code, bold, inline code, links) producing React elements. It never uses `dangerouslySetInnerHTML`, and it renders only `http:` and `https:` link targets. Handoff text is agent-written and this page carries the gate buttons, so injected HTML is a real risk; a library that emits HTML strings would need a sanitizer as a second dependency.
- **npm scripts** (added by tickets 04 and 07): `bridge` runs `node apps/bridge/server.mjs`; `ui:build` runs `vite build --config apps/ui/vite.config.mjs`; `ui` runs both in order, and is the one command of story 1; `ui:dev` runs the Vite dev server (HMR) with `/state`, `/metrics`, `/events` and `/requests` proxied to the bridge on 4317, for developer cells working on the UI. `apps/ci-cd/smoke.mjs` currently serves the repo itself, so ticket 13 gives it a "load this URL" mode and runs `ui:build` first; the bridge serves the static build with the MIME types from `apps/ci-cd/dev-server.mjs` (ticket 07 exports `contentTypeFor` from it rather than copying the table).

### 9. New dependencies, for the user's gate

Nothing is installed by this ticket. Proposed (exact-pinned like `playwright`; the developer verifies current versions with `npm view` and picks a matching React and R3F pair, either React 18 with `@react-three/fiber` 8, or React 19 with `@react-three/fiber` 9):

- runtime (bundled into the UI): `react`, `react-dom`, `three` (0.170.0 to match the dev scene), `@react-three/fiber`
- dev: `vite`

Explicitly not proposed: `@react-three/drei` (GLTF loading uses `three`'s `GLTFLoader`), `typescript`, `vitest`, `jsdom` or a testing-library, a chart library (spec: inline SVG), a markdown library (decision 8), `express` or any server framework (`node:http` is enough), and a file-watcher package (`fs.watch` recursive plus the 2 s net). The bridge, metrics and requests script add no dependencies. `security` should review the tree these add (`vite` brings esbuild and rollup with platform binaries).

**Considered options.**

- *Bridge as several small tested modules* (watcher service, snapshot service, SSE hub, each with its own tests). Rejected: it puts three shallow modules and three seams where the spec asks for one; the behaviour worth testing is what a client sees over HTTP.
- *Change events as JSON patches* or as "full snapshot again on every change". Rejected: patches force the client to carry a patch library and make the additive-keys rule harder; full snapshots resend up to 12 handoffs of 8 KB each per change. Typed upserts keep the reducer tiny, deep enough to test at one point, and additive.
- *Metrics inside the snapshot.* Rejected (decision 4). Kept as a live option if the charts ever need to update with every board change; the cost then is one `metrics` key added to the snapshot, which the additive rule allows.
- *No-build UI (React and R3F from a CDN importmap, JSX replaced by `htm`).* Rejected: it puts runtime network access and a duplicate-React risk on a tool whose job is to run locally, and R3F's ESM builds do not resolve cleanly that way. `three` from a CDN already exists in the dev scene and stays there.
- *Dispatch gate on every frontier ticket, or a proposals file the orchestrator writes.* Rejected for v0 as extra scope: deriving the gate from Board state needs no new orchestrator behaviour. The user can widen it later without changing existing keys. *(Done in part, 2026-10-12, organism-infra/154: every frontier ticket is dispatchable from the den, but the gate itself stays on `frontier[0]`; a gate on every frontier ticket would put a prompt per ticket in Needs you.)*

**Consequences.**

- Tickets 04 to 11 can write fixtures and assertions straight from the JSON above. Ticket 03 and 02 are unblocked by 01 but must read this ADR before implementing, since 03's output keys and 02's function signature are fixed here; the orchestrator should point their dispatch at it.
- Ticket 06 adds `apps/bridge/requests-log.mjs` (shared) and the handled-line format; ticket 12's genome edit reads the same `scripts/requests.mjs --list`.
- The `Gate request` term already exists in `CONTEXT.md`; no `CONTEXT.md` change is needed. `sessions`, `bumps` and `readySince` are implementation vocabulary.
- Ticket 04 and 05 need a fixture with a lock file, events rows with `verdict`, and an orchestrator-handoff set; `apps/organism-infra/board-fixture.mjs` covers locks and events but not `_handoffs` or `usage.jsonl`, so ticket 04 extends it.
- Ticket 07 is where the first dependency install happens; it stops for the user's gate before `npm install`.
- Age in the priority sort is imprecise on day-only handoff file names (`2026-09-28-orchestrator-6.md`); ticket 02 must decide how to compare them to `readySince` and record the rule.
