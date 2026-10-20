# Ticket 24 failed calls and corrected probes

No paid submission, model-service retry, dependency installation or rejected approval.
The final source tests pass; the full matched performance run has not started.

| Call | Exact signal | Resolution / interpretation |
|---|---|---|
| `rg --files ... meshy_output ...` in worktree | `meshy_output: No such file or directory (os error 2)` | Read the main source directory explicitly; inventory path friction |
| `command -v blender` | exit 1, no output | Optional tool absent; used existing Three authoring tools, no install |
| Broad `/tmp` render-script inventory | `Permission denied (os error 13)` on systemd-private/codex-daemon paths; vanished `/tmp/bridge-fx-wqFM9M` | Relevant prior script found; unrelated temp paths untouched |
| First local builder | `spawnSync python3 ENOBUFS` | Raw RGB was 3MiB; set the bounded child buffer to 4MiB |
| `sed .../scene/resident-inventory.mjs` | `No such file or directory` | Correct inventory is under `src/shell/` |
| Second local builder | `mergeGeometries() failed ... index attribute exists ...` then `Cannot read properties of null (reading 'computeBoundingBox')` | Normalize indexed/nonindexed garment inputs before merging |
| Initial native `cmd.exe` launch in sandbox | `UtilGetPpid ... Failed to parse: /proc/1/stat`; `UtilBindVsockAnyPort:307: socket failed 1` | Parent ran the same approved capture with escalation; subsequent host launches work with escalation |
| `ls -l /tmp/24-developer-tests.txt` | `No such file or directory` | Runner's initial passing summary had not published the requested log; reran via file-writing wrapper and verified final 17,437-byte log |
| First UV-bake regression | `14/68 forehead vertices are cream` | GLTF image sampling must use `flipY=false`; corrected vertical atlas origin |
| Tight forehead threshold after origin correction | `61/68 forehead vertices are cream` | Source region includes brow-edge vertices; use an explicit 85% cream tolerance; later preserve all original front-face topology |
| First CPU evidence script | `ENOENT ... apps/ui/den/manifest.json` | Add the trailing slash to the public-root URL |
| Sandboxed preview cleanup `pkill` | exit 1, no output | Per-call sandbox PID namespace hid the host process; identified exact owned PID with escalated `pgrep`, then terminated it |
| Search for unused graph-helper names | `rg` exit 1, no matches | Ordinary negative discovery result; no action required |
| Camera discovery including old `DenScene.jsx` name | `No such file or directory` | Read current `MeshyDen.jsx` and procedural `CameraRig.jsx` instead |

Expected test-first failures, before their implementations: missing `characters.bao`;
authored colour `.25` overwritten by rig debug colour `.8366`; missing Bao-only
`giant-panda` runtime selection; missing portrait fallback export. These are red-green
evidence, not unresolved failures.

Visual inspection also caught uniform simplification spending detail on the face,
UV-seam normal faceting, and sash intersections. The final builder retains 2,549
original face triangles, preserves source normals and fits/offsets the wrap against
the torso. Early preview images were replaced by final captures; provenance pins
only the final source/model/portrait hashes.

The initial review fixture lacked a meeting title and misnamed a meeting shot
`near-working`; corrected fixture-only captures distinguish Working from meeting
Listening and provide a valid title/ref. Direct camera-position mutation was
discarded because the explorer owns that state; the closer first-person fixture
uses its existing `walkStart` contract instead.

Existing Vite warning: a generated chunk exceeds 500kB. Build completed successfully;
no code splitting or dependency change was added to this character ticket.
