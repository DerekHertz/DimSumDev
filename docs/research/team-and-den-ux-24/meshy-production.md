# Selected Bao A: partial production checkpoint

User chose Meshy A. The selected source is now remeshed and packaged with its
textured face, robe, jade sash and pouch. The replacement stays confined to Claude
orchestrators; Jiao retains the original Codex source and portrait. No layout,
camera, router, installed service, dependency or purchase changes.

**Motion fitting is unfinished.** This is a WIP checkpoint, not a request to accept
the replacement. The new actual-mesh wave regression remains red. Native neutral
scene and portrait renders are useful for the next continuation but do not waive
the motion, fit, hardware or independent review gates.

## Reproduce

Retained source cache is the sibling `bao-24-source-cache/24-candidates/`, outside
the worktree. It contains both original candidates, the selected remesh and full
task trails. The CLI project is
`projects/20261020_105834_bao24-candidate-a_01a15a76` under that cache.

```sh
node apps/ui/assets-src/den/build-bao.mjs --source /path/to/remesh-a-7500.glb
node docs/research/team-and-den-ux-24/measure-bao.mjs
```

The builder verifies remesh SHA256 before the existing 23 packer preserves
geometry/UVs and makes one 512px color atlas. It cannot silently rebuild the
rejected vertex-color Bao. It is offline and spends no credits. The original
shipped model, costume and portrait remain the fallback.

Source task `01a15a76-e214-75bf-a510-25c77230a8a2`; remesh task
`01a15a82-843f-740c-a650-be1b2ad33877`. The remesh targeted 7,500 triangles and
returned 7,767. Actual charges: sources60 + remesh5 = **65 existing credits**;
verified account433 →373 →368. **35 remain under100; purchases$0.** No further
source, rigging, animation or texture generation was purchased. Price estimate
checked2026-10-20: <https://docs.meshy.ai/en/api/pricing>.

## Measured package and CPU pose costs

| Resource | Selected A |
|---|---:|
| Packaged gzip / decoded bytes | 288,510 /400,196 |
| Complete actor triangles, optional cup included | 7,847 |
| Shadow triangles | 7,767 |
| Base / maximum draws with cup | 1 /3 |
| Rig geometry buffers, excluding optional cup | 667,238 bytes |
| Bones / weights per vertex | 26 /4 |
| Unique atlas | one512×512WebP; matte color only |
| Estimated RGBA8 + mip atlas allocation | 1,398,101bytes (1.33MiB) |

`fitting.json` sweeps0.2s samples through4.8s of idle, sit, walk, tea, greeting,
pond and mahjong/work gestures. All published outer envelopes and floor limits
pass. This measures geometry, not correct deformation or collision clearance.
It does not establish desk, conversation or meeting-chair fit. Bao's current
runtime host anchor has no chair and remains standing; seated renders are
authoring previews only.

## Exact motion finding

The legacy profile initially rotated the raised paw toward the torso. A Bao-only
positive greeting direction corrects that. A second actual-mesh check detects
sleeve stretching under the inherited shoulder/weight bands. The WIP Bao profile
contains selected-A shoulder anchors and wider arm weights plus a bounded
shoulder/elbow greeting. Its current paw centroid reaches only1.916rigunits in
the tested frame, below the2.2 threshold. The edge-stretch assertion remains
unchanged and must also pass after fixing the pose. Do not disable this test or
claim that finite outer bounds prove satisfactory motion.

Next developer should fit the arm from the retained selected-A geometry, verify
all gesture phases and native wave deformation, then rerender the portrait and
all authoring/scene captures if the neutral pose changes. The shared gesture
defaults preserve every other character's existing direction and amplitude.

## Evidence and remaining gates

Native captures live under the existing visualization root in
`ticket24-meshy-production/`. `capture-authoring.cjs` captures five named poses in
both themes, a side render and a face-plus-robe portrait. The work authoring pose
uses the runtime's idle working posture. `capture-review.cjs` captures the actual
instrumented den, native Team40/62px portraits, a separate48/72px sheet, forced
fallback, near/overview, meeting and first-person views. Synthetic bridge events
are read-only and do not claim live backend action verification.

No full timed before/after GPU/frame/heap run has started. The new atlas probably
adds1.33MiB while legacy textures remain for Jiao and others. The aggregate
no-increase target remains unwaived; compare matched live allocations before
proposing a measured exception. Ticket23's separate allowance does not apply.
Full fitting/state/action checks, five disposal cycles, hardware comparison,
final user verdict, independent review, QA and delivery remain pending.

## Incidents in this continuation

- Startup refused `worktree is dirty (uncommitted or untracked files)`. Stopped;
  root moved only owned raw sources intact to the sibling cache; retry succeeded.
- Expected red test-first probes caught the legacy zero-atlas/non-Meshy package,
  inward wave, sleeve edge stretching and insufficient raised-paw height. The
  latter remains unresolved; no test was disabled or timeout increased.
- Windows host capture printed the normal UNC-current-directory notice and
  defaulted to Windows cwd; capture itself completed normally.

Capture receipt:347197369aec6d9711b192783d74adf59a721411;12actualden captures,zero page errors/zero writes,RTX3060Ti.NativeTeam40/62confirmed;forcedfallback retainedscale1.35,cameratarget[0,2,0],zoom1.After-only scene materialtextures68,estimatedRGBA+mips72,138,752bytes;no matchedbefore oractualVRAM comparison is claimed. Evidence hashes and summaries:meshy-production-capture.json.Focused runner smoke:61pass,1wavefailure;all changedJSsyntaxclean.
