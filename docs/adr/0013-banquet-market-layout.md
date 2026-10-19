# 0013: Banquet market layout

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

Status: accepted (2026-09-29, showcase-v1/01; decided there in place of character-animation/14)

## Context

With every cell perched on Bao's body, the scene crowds past about 12 cells and covers Bao's face. The user reviewed six layouts on the mockup canvas (https://claude.ai/artifact/LQjpimx1jfX5bjZEoTo3za) and chose a blend of "night market ring" and "banquet table" on 2026-09-29.

## Decision

- Bao sits behind a round banquet table as host. Only the 3 Pass cells ride on Bao: orchestrator on the crown, product on the left shoulder, architect on the right shoulder. The Pass rail and service bell stay on his crown.
- Steamers, Front of House, Tea and Pantry are pagoda-roofed market stalls around the table (back-left, back-right, front-left, front-right). A stall widens as cells join.
- The lazy susan is the ready queue: one steamer basket per ready ticket; the basket turned to a stall is being worked. A handoff turns the dish to the next stall.
- A cub basket for new cells sits front centre; Today's board stands front right.

## Anchor model

Implemented as a pure module, `apps/ui/src/scene/banquet-layout.mjs`; units are scene units, +z toward the camera.

- **Stations.** `stationOf(cellType)` gives `orchestrator`, `product`, `architect` (the Pass perches), `steamers` (developer, scout, debugger), `front-of-house` (designer), `tea` (qa), `pantry` (security), or `cubs` for any other type. `sceneFromState` writes each cell's perch as `<station>#<slot>`, the slot counting up within the station.
- **Pass perches.** Bao sits at [0, 1.4, -2.4], scale 1.4. Each Pass cell has a fixed anchor on his body, as a fraction of his box: crown [0, 0.96, 0], left shoulder [-0.55, 0.72, 0.1], right shoulder [0.55, 0.72, 0.1]. A second cell of the same type steps 0.4 outward.
- **Stalls.** Centres: Steamers (-4.8, -1.6), Front of House (4.8, -1.6), Tea (-4.8, 2.2), Pantry (4.8, 2.2), clear of Bao's shoulders. Posts are inset half a post inside the counter corners and the hip roof sits on the post tops. Each has three fixed slots along its front, 0.75 apart, at counter height 0.6, centred on the stall. Past three cells the stall grows by one slot per cell (`stallWidth`), outward only: `stallCenterX` shifts the centre away from x = 0 so every stall's inner edge stays at |x| 3.675 and Bao and the table stay centred (user, 2026-09-29). Slots 0 to 2 do not move while the stall holds three or fewer.
- **Cub basket.** At (0, 3.4) front centre. Cells of an unknown type stand in a row in front of it at z 4.6 (basket radius 0.55).
- **Lazy susan.** Round table at the origin: the visual top is radius 1.8 on four short legs; the layout radius used for baskets is 1.3, height 0.7. `susanBaskets(n)` places one basket per frontier ticket on a ring of radius 0.85, the first at the front, capped at 8. The susan turns slowly (still under reduced motion). Turning a basket to a stall on handoff is not built yet.

- **Camera.** x-only pan within ±5 and z-dolly zoom 0.55 to 1.2 (`camera-rig.mjs`); an 8-cell stall reaches |x| 9.3, past the pan limit (open item for showcase-v1/04).

## Consequences

- Replaces "all perch regions on Bao" from the character-animation spec. Tickets 05 and 06 change scope; new asset ticket 17 and board ticket 18.
- Fewer cells on Bao keeps the plush readable and helps the 30-cell budget (ticket 10).
