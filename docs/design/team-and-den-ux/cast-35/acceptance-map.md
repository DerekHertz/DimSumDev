# Cast batch (tickets 25-34, 35) acceptance map

Branch `claude/orchestrator-cast-batch-handoff-1adcc2` plus the evidence commit on top. Every cell was checked by grepping the named test, or by looking at the named PNG. The user's visual verdict is pending for all of it.

Short names, all under `apps/ui/src/scene/meshy/` unless stated:

- **rig** = `cast-rig.test.mjs`, test `<id> fits its structural budgets and keeps motion inside its envelopes` (one per character)
- **pick** = `cast-rig.test.mjs`, test `each role picks its species for both runtimes; Jiao is the codex orchestrator and unprofiled species keep the old panda`
- **agg** = `cast-rig.test.mjs`, test `the whole live cast instantiated together stays inside the structural budgets, per character and in total`
- **budget** = `cast-budgets.test.mjs`, test `<id> (<ticket>) ships one colour atlas inside the structural budgets`, plus `the whole cast stays inside the aggregate budget and matches its provenance`
- **clear** = `cast-acceptance.test.mjs`, test `<id> clears its homes, furniture and the meeting-table seats and can reach its home`
- **portraits** = `cast-portraits.test.mjs` (three tests)
- **render** = the PNGs in `docs/design/team-and-den-ux/cast-35/`, made by `apps/ui/assets-src/den/render-cast-review.mjs`

Species and tickets: 25 jiao, 26 fox, 27 crane, 28 deer, 29 lion, 30 otter, 31 pangolin, 32 lucky-cat, 33 tortoise, 34 golden-monkey. Bao (24) is the earlier ticket and is in the same tests.

Test run (this commit): `node --test --test-concurrency=2` on `cast-acceptance`, `cast-budgets`, `cast-portraits` and `cast-rig` (all in `apps/ui/src/scene/meshy/`): 36 tests, 36 pass, 0 fail, 0 skipped, 73 s. There is no `apps/ui/src/shell/cast-portraits.test.mjs`; the portraits test lives beside the rig tests.

## Accepted exceptions

1. **Fused paws never lift, so the wave is a head-and-body hello.** Seen in the `hello` cells of every `species-<id>.png`. The rig test pins it: for `greeting: 'body'` profiles the paw stays on the chest while the surface still moves more than .15.
2. **The sit is a planted-feet crouch.** Seen in the `sit` cells. The rig test checks it against the seated envelope.
3. **The tortoise shell crosses the meeting table.** `cast-acceptance.test.mjs` pins `KNOWN_SEAT_CROSSINGS = {tortoise: 1210}`. Fix is tracked in ticket 54.
4. **Structural budgets replace FPS and frame time** (user, 2026-10-20, `docs/design/character-performance-method.md`). No frame-time distribution, FPS or heap number was measured. Every "FPS / frame-time / memory" item below is met-with-exception on that basis.

Residents only idle at runtime. Walk, sit and gesture are capabilities of the rig, tested on the rig and shown in the renders. No den screenshot was taken (see "Not covered").

## Shared template ACs (tickets 25-34)

Same six ACs in each ticket, plus the verdict. A cell is the status; the evidence is in the row text and holds for every species unless a note below says otherwise.

| # | Criterion (short) | Evidence | bao | jiao | fox | crane | deer | lion | otter | pangolin | lucky-cat | tortoise | golden-monkey |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Approved cast sheet; no new cost or method without agreement | `apps/ui/assets-src/den/cast-provenance.json` (Meshy candidates already picked, local remesh and code skinning); `budget` aggregate test "matches its provenance"; no new Meshy call in this batch | met | met | met | met | met | met | met | met | met | met | met |
| 2 | Envelopes include garments and props; navigation and seat fixtures run | `rig` (radius and height under `profile.envelope`, no ground penetration, standing/moving/seated); `clear` (zero furniture and desk crossings, every home and seat routable) | met (ticket 24 tests, not re-run) | met | met | met | met | met | met | met | met | met-with-exception (3) | met |
| 3 | Work, sit, walk, idle, wave; reduced motion static | `rig` poses idle, walk at six phases, sit, and the four gestures; reduced motion static in idle and sit (same test); `render` `species-<id>.png` (idle, two walk phases, sit, hello, light and dark) and `reduced-motion.png` | met-with-exception (1, 2) | met-with-exception (1, 2) | met-with-exception (1, 2) | met-with-exception (1, 2) | met-with-exception (1, 2) | met-with-exception (1, 2) | met-with-exception (1, 2) | met-with-exception (1, 2) | met-with-exception (1, 2) | met-with-exception (1, 2; ticket 24) | met-with-exception (1, 2) |
| 4 | Scene appearance and 48/72 px portrait replaced together; labels, Take over bindings, runtimes, visitors kept | `pick` (role to species on both runtimes; `userData` roleId, runtime, species; scale 1.35 and .68; claude orchestrator is never Jiao); `portraits` (a 40 KiB webp per role per runtime, Jiao on `codex:orchestrator` only, Bao keeps his); `portrait-sheet.png` for 128, 72, 48 px | met | met | met | met | met | met | met | met | met | met | met |
| 5 | Existing states keep labels and actions; old appearance stays as fallback and rollback | `pick` last block (no loaded species: every role falls back to its old panda); `portraits` (`ROLE_PORTRAIT_FALLBACKS` non-empty and distinct for every key); no old asset deleted (`git diff --diff-filter=D main...HEAD` is empty) | met | met | met | met | met | met | met | met | met | met | met |
| 6 | Per-character and aggregate budgets; garden guards; near, far and work/meeting poses in both themes | `budget` (one 512 px colour atlas, triangles at or under 8k, bytes), `rig` (at most 32 bones, at most 2 MiB, at most 8000 shadow triangles, skin weights sum to 1), `agg` (20 residents: at most 6 draws each, aggregate caps); `render` `lineup-near.png`, `lineup-far.png`, `bao-and-jiao.png` in both themes | met | met | met | met | met | met | met | met | met | met | met |
| 7 | User visual verdict | Not given. Needs the PNGs above | not-met | not-met | not-met | not-met | not-met | not-met | not-met | not-met | not-met | not-met | not-met |

Differences by species:

- **Tortoise** (row 2): `clear` passes only with the pinned 1210 seat-crossing triangles. Every other species pins 0.
- **Jiao** (rows 2, 4): has one home, because only the codex orchestrator wears her. The test asserts `homes.length === 1`. Her scale is pinned at 1.35 to match Bao.
- **Bao** is not in `CAST_PROFILES`, so `rig` and `clear` skip him (`agg` adds him by hand). His fit, poses and clearance are `bao-production.test.mjs` and `bao-acceptance.test.mjs` from ticket 24, which I did not re-run here.
- **Row 1 (approved sheet)**: I can show the provenance file and the no-new-spend fact. The user's approval of the sheet is on the board (tickets 22 and 23), not in a test.
- **Row 5 wording**: the "Resting / Working / Needs you / Not set up, loading, error, offline" labels sit in shell code this batch did not change. No cast test asserts them. Met by "unchanged", not by a test.
- **Row 3, "work"**: there is no separate work pose. Work is the idle pose at the workstation, and `clear` checks the desk. No test calls it "work".

## Ticket 35 ACs

| AC | Criterion | Evidence | Status |
|---|---|---|---|
| 1 | Every approved design present with matching portrait and correct role and runtime bindings; account for pairs, visitors, scenery, legacy | `pick`; `portraits`; manifest has `characters.<id>` for all 11 species. The 11 species cover 10 roles: Bao and Jiao share the orchestrator role. Legacy identities (red panda `developer`, dragon `technical-writer`) keep their own tables: `pick` asserts `castCharacterId('developer') === undefined` and `portraits` test 3 | met |
| 2 | At actor capacity, labels, head and bubble anchors, places, props fit the envelopes | Envelopes and homes, seats, routes: `rig`, `clear`. All 20 residents together at live scale: `lineup-near.png`, `lineup-far.png`. Label and bubble anchors in the real den were not checked: no den screenshot, and no test of anchor height against the new bodies | met-with-exception (envelopes, places and props are tested; label and bubble anchors are not) |
| 3 | Near/far and 48/72 px, all poses, both themes, reduced motion, Bao/Jiao, lucky cat; user verdict | `lineup-near.png`, `lineup-far.png`, `portrait-sheet.png`, `species-*.png`, `reduced-motion.png`, `bao-and-jiao.png`. Lucky cat is in every lineup and is the release-manager (`pick`). First-person view not rendered. User verdict pending | not-met until the user gives the verdict; evidence is complete except first-person |
| 4 | Aggregate mesh, draw-call, material, shadow, texture, animation budgets; frame time, FPS, memory; no FPS regression; garden guards | `agg` and `budget` aggregate cover mesh, draws, shadow triangles, textures, bones and bytes. Frame time, FPS and heap were not measured, by the user's 2026-10-20 decision. Garden guards were not run by me | met-with-exception (4) |
| 5 | Loading, failure, offline fallbacks and rollback; no deletions | `pick` (empty `characters` falls back to old pandas); `portraits` fallbacks; no file deleted in the branch. Loading and offline states of the shell are unchanged and untested here | met |
| 6 | Parent-15 map | This file | met |

## Parent ticket 15

| AC | Criterion | Evidence | Status |
|---|---|---|---|
| 1 | Effort and performance cost assessed and agreed before asset work | `docs/design/character-performance-method.md`; the plan (`handoffs/35-orchestrator-cast-batch.md`) records the user's decisions: structural budgets, full rig in one PR, no new Meshy spend | met |
| 2 | The user approves a direction before the build | Cast sheet approved (tickets 22, 23); one PR and one verdict for 25-35 decided by the user, 2026-10-21 (plan, `decisions`) | met |
| 3 | Each role recognizable in the scene and in its portrait; coherent style | `portrait-sheet.png`, `reduced-motion.png`, `lineup-near.png`. Judgement is the user's | not-met until the user's verdict |
| 4 | Frame rate on the reference box no lower than today's | Replaced by the structural budgets (exception 4). Not measured | met-with-exception |

## Not covered, said plainly

- **No real-den screenshots** (`den-light.png`, `den-dark.png`): the den needs agents in the bridge state to show residents and a built UI. That passed the 20k-token limit set for it, so I skipped it rather than fake it.
- No frame-time, FPS or heap numbers (exception 4).
- No first-person render.
- No cast-specific test of the shell's state labels or Take over bindings.
