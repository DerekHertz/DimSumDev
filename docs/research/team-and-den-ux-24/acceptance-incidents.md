# Bao 24 acceptance continuation: failed calls and diagnostics

No additional Meshy stages, purchases, dependency edits or installed-service changes. `agent-start --continue` succeeded and itself reported installing/auditing 138 packages, zero vulnerabilities. Root authorized merging fetched `origin/main`; merge was clean (`131bd32`).

| Call | Exact failure or observation | Resolution / classification |
| --- | --- | --- |
| `jg question --cwd ...` | `Unknown option or missing option value. Run jg --help.` | Corrected to documented positional search root; completed with `End context.` Tool invocation error. |
| `rg --files ... /tmp/den-cast-23` | `No such file or directory (os error 2)` | Existing native artifacts were under Windows Temp; read those paths. Discovery error, no install. |
| Scoped `rg`/`cat` optional guessed paths | Missing `overlay/Residents*`, `overlay/Thread.jsx`, `state/store.mjs`, `state/stream.mjs`, `state/use-live*`, `state/live.mjs`, `state/index.mjs`; `No such file or directory` | Used exact existing filenames from `rg --files`/imports. No application changes. |
| Runner discovery | Missing optional `scene/meshy/plush/garden.mjs` and `scene/meshy/meeting-table.browser.test.mjs` | Actual files located under their current paths. |
| Initial native acceptance | `ReferenceError: __cast22 is not defined` | Fixed observer readiness guard to `globalThis.__cast22?.…`; no product change. |
| Native Talk on original Bao | `locator.click: Timeout 30000ms exceeded` / `Talk to Bao` disabled | Finite fixture SSE closed and put the UI into reconnecting state. A persistent local HTTP SSE fixture restored live connection; same exact visitor-run POST then passed. No timeout increase, state bypass, or production change. |
| Sandbox owned-server restart | `pkill` exited 1; then `Error: listen EADDRINUSE: address already in use 0.0.0.0:4425` | Stopped and reported environment boundary. Root verified PID/cwd/command and stopped only the owned server. Resumed on verified free port using escalation. No service workaround. |
| Native profile assertion | Expected `/Host task/`; actual current-shell text `acceptance/main` | Current live adapter carries the ticket reference, not fixture `task`. Asserted the exact current baseline ticket binding instead; same baseline/candidate behavior. |
| Initial actual-asset integration fixture | `Missing fitted vest template for orchestrator` | Added the actual fitted vest source for legacy Jiao/Bao fixture path. Fixture construction error. |
| Same-ref anchor diagnostic | Expected 3 live figures, actual 2 | Reproduced with both original and selected Bao. `boundAgentKey` intentionally keys ticket anchors by project/runtime/role/ref; independent same-ref bodies/cards/run IDs remain intact. Root directed preservation test to assert distinct-ref figures and exact same-ref actions, preserving this diagnostic as a pre-existing orchestrator follow-up, not a passed or waived run-anchor criterion. |
| Runner syntax check | `Cannot find module '…/test/native-performance.cjs'` | Correct existing research path checked and passed. Invocation error. |
| New chair test first path | `Cannot find module '…/.worktrees/docs/research/team-and-den-ux-24/clearance.mjs'` | Corrected relative path from six to five parents; reran to the actual expected geometry failure. |
| Actual chair red probe/test | `Bao seated mesh penetrates the actual stool: 59 crossing triangles` | Real rounded cushion intersection at fixed stool center/floor anchor. Fixed Bao-only seated pelvis drop `.12 → .0531`; unchanged assertions now pass, including positive near-contact nudge and floor/deformation checks. |
| Authoring placement / leg parameter probes | 35 fixed-height horizontal placements still crossed; hip/knee/splay probes left 48–65 cushion crossings | Did not claim a floating/displaced fit. Contact bisection isolated the pelvis-height correction; detailed pre-fix receipts retained externally. |
| Concurrent Bao body diagnostic | Exact posed triangle intersections in both original and selected appearances at observed native visitor positions | Recorded in `pair-clearance.json`; scope decision belongs to orchestrator. Not silently called clear. |

Native `cmd.exe` emitted the usual nonfatal UNC-cwd notice and defaulted to Windows directory; every native command used absolute paths. Intentional owned-server SIGTERM is cleanup, not an acceptance failure. Full matched GPU run is not yet executed at this checkpoint.
