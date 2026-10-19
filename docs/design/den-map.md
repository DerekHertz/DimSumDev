# Den map

One page to build the Level 1 den from. Where each thing stands, which constant places it, which tokens colour it, and what to check. Why each piece looks the way it does is in [2026-09-29-scene-decisions.md](2026-09-29-scene-decisions.md); words are in the design system's Glossary.

World units, three.js axes: +x right, +z toward the camera, y up. The table is the origin. "Now" is `main` at `f6be2f4`; "Target" is the 09-29 horseshoe. Target positions may move up to ±0.3 if the checks still pass.

```
              z
   -2.4       ·              [ Bao ]            ← Pass pandas on crown + shoulders
   -1.4       ·   [Steamers 蒸]         [Front of House 堂]    back row, on 0.5 platform
    0.0       ·            ( lazy susan )        table r 1.3
    2.0   [Tea 茶]                                [Pantry 仓]  front row
    3.0       ·      {Cubs 崽}          #Tally#  (Library 书 shelf, planned)
   11.5       ·                camera
         x: -4.9  -3.0  -1.8   0   1.8  3.0  4.9
```

## Placement

| Thing | Now (x, z) | Target (x, z) | y / size | Yaw | Constant to change |
|---|---|---|---|---|---|
| Bao | 0, -2.4 | unchanged | y 1.4, scale 1.4 | 0 | `BAO` |
| Table + susan | 0, 0 | unchanged | r 1.3, h 0.7 | — | `TABLE` |
| Steamers kiosk | -4.8, -1.6 | **-3.0, -1.4** | platform 0.5 | **+0.52** | `STALLS.steamers` |
| Front of House kiosk | 4.8, -1.6 | **3.0, -1.4** | platform 0.5 | **-0.52** | `STALLS["front-of-house"]` |
| Tea kiosk | -4.0, 2.2 | **-4.9, 2.0** | ground | **+0.52** | `STALLS.tea` |
| Pantry kiosk | 4.0, 2.2 | **4.9, 2.0** | ground | **-0.52** | `STALLS.pantry` |
| Cubs hamper | 0, 3.4 | **-1.8, 3.0** | r 0.55 | 0 | `CUB_BASKET` |
| Tally abacus | 1.5, 3.4 | **1.8, 3.0** | frame ≈ 1.1 wide × 1.4 tall on short legs; replaces plinth + tablet | faces camera (keep formula) | `TALLY` |
| Library shelf (planned) | — | 2.9, 3.3 | — | faces camera | new, when the role exists |
| Camera (default) | 0, 11.5 | unchanged | — | — | `camera-rig.mjs` |

Kiosk yaw is the turn toward the table, capped at ±0.52 rad (30°) so the noren sign stays readable from the camera. The rule is `clamp(atan2(-x, -z), -0.52, 0.52)`. Every constant above lives in `apps/ui/src/scene/banquet-layout.mjs`.

## Where pandas stand

| Team | Pandas | Where |
|---|---|---|
| The Pass 传 | orchestrator, product, architect | On Bao, `PASS` fractions (crown, left shoulder, right shoulder). Unchanged. |
| Steamers 蒸 | developer, scout, debugger | Behind the counter, spaced `STALL_SPACING` 0.75; the kiosk widens past 3 slots |
| Front of House 堂 | designer, docs writer (planned) | Behind the counter |
| Tea 茶 | qa | Behind the counter |
| Pantry 仓 | security | Behind the counter |
| Cubs 崽 | cubs with no role | Inside the hamper, one per idle cub |
| Drum 鼓 (planned) | release manager | On Bao; placement decided in its ticket |

Pandas never roam open grass. The only time one leaves its spot is a handoff, when it walks the arc from one kiosk to the next carrying a dumpling. `roam.mjs` loses free roaming.

## Kiosk parts (all four the same)

| Part | Look | Token |
|---|---|---|
| Roof | Upturned eaves, tile | `panda-ink` |
| Eave trim | A line along the eave | `station-<name>` |
| Posts, counter band | — | `station-<name>` |
| Counter body | Wood | wood (existing `WOOD`) |
| Noren curtain | Hangs under the eave; team name in `display` | `station-<name>`, text `surface-200` |
| Lantern | One, at the front eave corner nearest the table | unlit `surface-200`; lit `lantern-fill` only when a panda there is `waiting_on_user` |

Team hues replace the `HUE` map in `Market.jsx`. Delete the sphere lanterns.

## Lazy susan

| Tier | Holds | Layout | Token |
|---|---|---|---|
| Bottom (on table, r ≈ 0.95) | Ready tickets as steamer baskets, max 8 | 45° apart; the next basket faces the camera | basket bamboo; lid tag shade by priority, darkest P0 |
| Top (raised 0.25, r ≈ 0.5) | Claimed tickets as plated dumplings | Evenly spaced | plate rim `station-<claimer>` |
| Overflow | Tickets past 8 | A basket stack on the table's right edge, with a `+N` pill | pill `surface-200` |

A claim turns the bottom tier one step (`dur-slow`) and moves the basket up as a plate. Reduced motion shows the end state. This lives in `susanLayout` in `handoffs.mjs`. The corner caption "+N more in queue" goes.

## Set pieces

| Thing | Look | Tokens | Interaction |
|---|---|---|---|
| Tally abacus | Wooden suanpan with 5 labelled rods: 5 h, Week, Served, Tokens, Spills. One bead per tenth of scale; counted beads slide right in the rod colour, the rest stay wood | usage and served `qi`, tokens `station-steamers`, spills `alarm`; 80% mark `lantern-fill`; usage past 95% `alarm` | Click or Enter opens the charts. Usage rods are `role="meter"` with an `aria-label`. Beads slide over `dur-base` on change; reduced motion jumps. |
| Cubs hamper | Lidded bamboo hamper with a blanket; `zzz` over the sleeping cubs | blanket `station-pass` | None |

## Screen chrome (DOM, not 3D)

| Where | What | Design system component |
|---|---|---|
| Right sidebar, 400px | Title + Live · Needs you · Teams (pills + glyphs, dashed "coming online") · Queue | ApprovalCard, PandaTile |
| Bottom-left | Zoom switcher: 1 · Den, 2 · Team, 3 · Panda, 4 · Workspace, with + and − | — |
| Bottom-centre | Intent bar: autonomy, input, `Ctrl K`, Send, with the current intent above | AutonomyControl |
| Bottom-right | Timeline: Live, time, "Drag back to replay the den's history" | — |

The sidebar no longer shows plan usage; it's on the Tally abacus. The target frame is "Level 1 · Den (target)" on the zoom frames canvas.

## Checks (for qa)

1. At the default camera, no kiosk's sign or counter is covered by another kiosk, by Bao, or by the table.
2. With no panda waiting, no lantern in the scene is `lantern-fill`. Each stall with a waiting panda has exactly one lit lantern.
3. Bottom-tier baskets = min(ready, 8). The overflow pill = ready − 8 when that's above 0. Top-tier plates = claimed tickets.
4. No panda stands on open grass unless it's mid-handoff.
5. The abacus 5 h and Week rods match `usage.jsonl` (rounded to the nearest bead), and the sidebar has no usage meter.
6. The kiosk hues match the `station-*` tokens; `Market.jsx` has no hex hue map.
7. No biology word (organism, organ, cell, genome, apoptosis, endocrine) appears in any visible label or `aria-label`.
