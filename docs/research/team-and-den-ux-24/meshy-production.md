# Selected Bao A: rig fitting checkpoint

User chose Meshy A. The selected source is now remeshed and packaged with its
textured face, robe, jade sash and pouch. The replacement stays confined to Claude
orchestrators; Jiao retains the original Codex source and portrait. No layout,
camera, router, installed service, dependency or purchase changes.

The retained actual-mesh wave regression and the new static-rest/cycle checks now
pass. This is a fitting checkpoint; furniture clearance, matched performance,
independent review and the user's visual verdict remain pending. No further paid
stages were run during fitting.

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

The updated measurement script sweeps25 frames per state through4.8s of idle,
work, sit, walk, tea, greeting, pond and mahjong. It checks outer/head envelopes,
floor limits and actual surface-edge stretch. Pass an output path to retain prior
evidence. The head radius follows the source's upper-head vertices, rather than
mistaking a raised paw for part of the head.
It does not establish desk, conversation or meeting-chair fit. Bao's current
runtime host anchor has no chair and remains standing; seated renders are
authoring previews only.

## Motion findings and changes

The inherited shoulder pivot was too far out and low. Moving it from[1,1.5] to
[.8,1.65] and removing the compensating elbow rotation raises the test-frame paw
centroid from1.916 to2.250, above the retained2.2 threshold. A broader sleeve blend
with a sloping underarm excludes the robe hem/pouch; peak wave edge stretch is
2.156× across the sampled cycle, below the unchanged3× limit. Broader inner-thigh
weights reduce seated robe/leg stretch from4.419× to2.687×. Idle/work and walking
peak at1.486× and1.734× respectively. These are deformation guards, not aesthetic
acceptance or collision tests.

Bao's fitted arm drop is.65. It opts into retaining that resting posture when
reduced motion stops ambient animation; the mesh exactly matches normal idle at
time0 and stays still across time and stopped walking. Other character profiles
retain their existing static defaults. Normal work uses the existing idle posture.
The atlas, geometry/UVs, costume, other identities and runtime bindings stay intact.

## Evidence and remaining gates

Prior native captures live under the existing visualization root in
`ticket24-meshy-production/`; fitting captures use a new `ticket24-meshy-fit/`
folder. `capture-authoring.cjs` captures five named poses in
both themes, a side render and a face-plus-robe portrait. The work authoring pose
uses the runtime's idle working posture. `capture-review.cjs` captures the actual
instrumented den, native Team40/62px portraits, a separate48/72px sheet, forced
fallback, near/overview, meeting and first-person views. Synthetic bridge events
are read-only and do not claim live backend action verification.

No full timed before/after GPU/frame/heap run has started. The new atlas likely
adds1.33MiB while legacy textures remain for Jiao and others. The bounded capture
harness now observes GL texture storage calls for a matched loaded/fallback pair;
results will accompany the new checkpoint. The aggregate
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
