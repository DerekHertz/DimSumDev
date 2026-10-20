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
| Initial full performance validation | `AssertionError: 1384 !== 1440` | The harness confused viewport size with canvas size. Current04 reserves56px rail and44px bar: 1440×900 viewport,1384×856 canvas. Corrected strict expectations on both sides; retained initial failure receipt, then ran all-scenario metadata/hardware preflight before the full restart. No sampling/budget threshold weakened. |
| User-requested benchmark pause | `page.waitForTimeout: Target page, context or browser has been closed` | Deliberately closed only the owned Chrome; Node catch/finally preserved45 complete runs. Not an environment/performance failure. No final verdict or further runs after the stop. |
| Initial native cleanup inspection | Bash expanded PowerShell's dollar-underscore token and the echoed command exposed the configured TypeSafe credential (`TYPESAFE_API_KEY`) in tool output | Quoting mistake acknowledged immediately to root. No value copied into files/reports. Switched to file-based native helper with argument arrays; user credential rotation remains necessary. This was not an approval rejection. |

Native `cmd.exe` emitted the usual nonfatal UNC-cwd notice and defaulted to Windows directory; every native command used absolute paths. Intentional owned-server SIGTERM is cleanup, not an acceptance failure. Full GPU results are reported separately; preflight and failed initial validation never count as acceptance samples.

## Resumed developer evidence round

| Call | Exact failure or observation | Resolution / classification |
| --- | --- | --- |
| Initial scoped file discovery | `rg: .scratch: No such file or directory (os error 2)` and same for `.den` in the worktree | Used the main board and known research files. Invocation/discovery error. |
| Overbroad optional temp discovery | `Permission denied (os error 13)` for protected `/tmp` service/daemon directories | Stopped broad discovery; no permissions changed or files accessed. Ordinary Linux read boundary. |
| Optional guessed role-doc path | `cat: docs/agents/genome.md: No such file or directory` | The developer role definition was already read at `.codex/agents/developer.toml`. Discovery error. |
| Expected resume-test red | `Cannot find module ./performance-resume.cjs` | Tests written first; new helper makes all five pass. Expected TDD red. |
| New summary tests against previous script | `The string argument must be of type string. Received type undefined` and `Missing expected exception.` for a59-run dataset | Corrected declared percentile/named CPU reporting and mandatory full-recipe guards. Two tests pass; `/tmp/24-summary-red-tests.txt` retains expected red. |
| Captured-data performance gate | `AssertionError: unchanged per-scenario five-percent acceptance gate` | Three GPU and two combinedCPU scenario gates fail. Retained all60 rows; no waiver or sample replacement. Genuine measured acceptance failure; cause unresolved. |
| First source-path probe during bounded diagnosis | Missing `plush/characters/bao*.mjs` and `plush/character*.mjs` | Used exact files from scoped `rg --files`. Discovery error. |

Continuation startup itself ran the existing lockfile install and reported engine warnings under WSL Node18 plus one moderate audit finding; no dependency files were edited or audit fix attempted. Native captures used the established Node22 executable. All native calls used file-based helpers/literal argument arrays with TypeSafe absent; no Jev/TypeSafe calls or credential inspection occurred. Nonfatal native UNC-cwd notices persisted. No automatic approval rejection occurred in this round.

### Original/original control round
- Expected TDD red: identical-control.test.mjs could not find identical-control.cjs before implementation; implemented generator, targeted tests green.
- apply_patch report append failed because expected final sentence said inline scripts/logs while file said inline recomputation/output; reread last8lines and added separate identical-control.md plus exact matching report link. Fixable patch-context friction; no data changed by failed patch.
- Native cmd emitted standard UNC cwd fallback notice; capture completed successfully from explicit paths. No automatic approval rejection, timeout, service action or Jev/TypeSafe call.
- Runner exploratory arithmetic inspection read nonexistent raw.gpu[0]: TypeError: Cannot convert undefined or null to object. It switched to actual raw shape and completed independent checks; fixable schema-discovery friction.
- Runner initially resolved immutable files under absent worktree .scratch: ENOENT for .scratch/resumed/performance-assembled-60.json. It used the supplied external acceptance root instead; both hashes matched. Fixable path-discovery friction.
