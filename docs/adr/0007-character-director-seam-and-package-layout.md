# Character director is a pure package, not part of the scene renderer; distant cells sample it at a reduced rate

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Context.** The character director maps cell state, handoff events, perch anchors, a reduced-motion flag and time to clip, face-frame and root-transform commands (`spec.md`, "Character director"). It is the one seam the animation testing plan is built around, and user story 31 asks for it "as a pure module with no renderer dependency, so that I can test it quickly." No app code exists yet, so this ADR also sets the first UI package layout, and answers the update-rate question `spec.md` left open for Level 1's up to 30 cells.

**Decision.**

1. **Seam.** The director ships as its own package, `packages/character-director`, with zero dependency on `three`, `@react-three/fiber`, or any DOM/WebGL API. Its interface: push cell-state-changed and handoff events plus perch anchors and a reduced-motion flag into it as they occur, and call `tick(cellId, now)` to sample commands (clip name, face frame, root transform) for a point in time. `apps/ui` owns everything the director doesn't — the R3F scene graph, camera, `AnimationMixer` playback, and applying sampled commands to meshes. The director is the deep module (state machines, hop/waddle path math, interrupt handling, the calm rule); the renderer is a thin adapter over it. Every director test runs in plain Vitest with no renderer or WebGL context.

2. **Package layout.** First cut of the monorepo:
   ```
   apps/ui/                       React + R3F app: camera, scene graph, mesh/mixer adapters, dev tools
   packages/character-director/   the seam above; also ships a StateSource contract and a mock adapter
   daemon/                        Node daemon (not built yet)
   ```
   `character-director` is the only shared package for now. We are not pre-creating a `domain-types` or `ui-kit` package before a second consumer demands one.

3. **Mock state source.** The director's input is a `StateSource`: anything that pushes cell-state-changed and handoff events shaped like what the daemon will eventually emit (the event envelope in `design-brief.md` §10, trimmed to `cell_id`, `state`, `ts`). Until the daemon exists, `character-director` exports `createMockStateSource()` satisfying that same contract; the throwaway prototype (ticket 01) and the dev control in ticket 04 drive the scene with it. When the daemon ships, a `daemonStateSource` adapter in `apps/ui` (consuming ADR-0004's runtime-adapter event stream) replaces it behind the same interface. The mock does not get thrown away: it becomes Demo mode's synthetic feed (`design-brief.md` §6).

4. **Distant-cell rate.** Level 1 can show up to 30 cells at once, each too small on screen for breathing, blinks or a paw-raise bob to read — the 2-second glanceability rule is served by pose, icon and word, not by fine motion at that scale. Rather than teach the pure director about the camera, `apps/ui` classifies each cell's on-screen size into a `focused | distant` tier every frame (a renderer concern) and passes that tier into a director-owned, still-pure scheduling rule: focused cells are ticked every frame; distant cells are ticked at a fixed low rate (default 8 Hz, tunable) instead of 60. Because `tick` samples a continuous timeline rather than integrating per-frame deltas, sparser sampling degrades smoothly rather than choppily, and the same rate is used for hops and waddles so travel stays legible at a glance. The exact default is provisional — ticket 10 measures real frame cost at 30 cells and may set the interval to zero (no throttling) if a 10-bone mixer at 60 Hz for 30 cells turns out to be cheap enough. What this ADR fixes is the mechanism and where it lives (a pure, testable rule inside `character-director`; on-screen-size classification stays in `apps/ui`), not the number.

**Considered options.**
- *Director lives inside the R3F scene tree* (a hook that computes the mapping and drives Three.js objects directly in one place). Rejected: every director test would need a renderer/WebGL context, contradicting user story 31.
- *Director as a folder inside `apps/ui`, boundary enforced only by an eslint import rule.* Rejected: the boundary would be a convention, not a fact, and the director already has two real adapters (mock now, daemon later) and two real consumers (renderer, tests) — per `codebase-design`'s "two adapters means a real seam," it earns a package with a compiler-enforced boundary.
- *Camera or distance as a director input.* Rejected: it would tie the pure module to viewport concepts. Keeping classification in the renderer and passing only the resulting tier into the director leaves the director's five inputs (state, handoff, perches, reduced-motion, time) unchanged.
- *No distant-cell throttling ("none").* Live option: the calm rule already bounds loop speed, so throttling may prove unnecessary. Not picked outright because ticket 10 exists specifically to measure 30-cell cost, and building the scheduling hook now costs nothing versus retrofitting a rate limit into an already-wired director later. Ticket 10 can still land on "none" (interval = 0) once it has real frame-time numbers.

**Consequences.**
- `packages/character-director` needs its own `package.json`, `tsconfig`, and test runner wiring before tickets 01, 03 and 04 can import it — a small addition to their setup, not a blocker to this ADR.
- Ticket 03, blocked on "02 (package layout)," is unblocked by decision 2.
- No new domain terms: "character director," `StateSource`, and "tick tier" are architecture vocabulary, not user-facing domain concepts, so `CONTEXT.md` is unchanged.
