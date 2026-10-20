# Ticket 22 run and validation record

The accepted capture contains 10 scenarios, 3,590 real render samples and 1,198 GPU query samples, on the verified Windows RTX 3060 Ti. All accepted fixtures asserted their actual actor count. No replacement assets, paid generation, package dependency changes, main-checkout source edits, installed update or router start occurred.

## Checks performed

- Existing `scene-budget.test.mjs`: 2/2 pass; fresh garden-only count 1,772,169 triangles / 477,576 potential shadow triangles.
- Optimized Vite measurement build succeeded with two observation-only transforms. Its existing large-chunk warning was not treated as a failure or changed in this research ticket.
- Syntax checks passed for the measurement server and both Windows browser scripts.
- Parsed all 22 actual GLBs recursively; manifest triangle totals agree, all have zero embedded skins/joints/clips. Runtime skeleton has 26 bones.
- Source/portrait map: 25 residents, all 25 corresponding portraits exist. Actual assembled actor probe adds per-role triangles, materials, textures and posed bounds; 15 ambient bodies are inventoried separately.
- Independent research-helper review checked inventory mappings, 25/29/35 +15 ambient counts, scope/version limits, proof arithmetic and credit totals. It found no remaining cost/count error; the owner corrected the earlier charter/shell interpretation before publication.
- No full application suite or production crash/stability soak was run: application code was unchanged. Browser measurements used actual GPU draws and fixed synthetic read-only state, not the DOM-test draw-skipping helper.

## Failed calls and discarded probes

These were recovered or explicitly discarded; none is hidden as a passed measurement.

| Tool / short command | Exact distinguishing failure | Recovery / classification |
|---|---|---|
| exec, `git fetch origin main` | `error: cannot open '.git/FETCH_HEAD': Read-only file system` | Approved metadata-only escalation succeeded; filesystem guard, no main checkout update. |
| exec, sandbox Windows PowerShell hardware read | `UtilGetPpid ... Failed to parse: /proc/1/stat`; `UtilBindVsockAnyPort ... socket failed 1` | Approved read-only Windows interop escalation succeeded; sandbox/process-namespace friction. |
| exec, `Get-Process chrome,msedge` | exit 1 after valid Chrome/memory output; absent requested process name | Used explicit executable-existence checks and isolated Chrome; no user process changed. |
| exec, sandbox `wslpath -w ...` | `wslpath: ...: No such file or directory` with the same WSL process-namespace error | Escalated path resolution succeeded; path was valid. |
| exec, `rg ... SceneCanvas.jsx` | `No such file or directory (os error 2)` | Used inventory and actual App.jsx; filename-assumption error. |
| exec, `cat .../meshy/daily-routines.browser.test.mjs` | `No such file or directory` | Read the actual test in its parent scene directory; filename-assumption error. |
| exec, Windows probe via worktree UNC | `Cannot find module .../node_modules/playwright` | npm ci had raced checkout completion and did not populate this worktree; reran it after checkout, then copied the existing pure-JS Playwright packages to the Windows evidence folder. No dependency added. |
| exec, package copy before corrected install | `ENOENT ... lstat .../node_modules/playwright` | Corrected install order and copied existing packages; one premature follow-up probe repeated MODULE_NOT_FOUND and produced no measurement. |
| exec, guessed installed build path | `ENOENT ... '/home/dhertzell/.local/state/den/current/build.json'` | Enumerated state layout, then read ui/current/build.json; installed v0.1.7 recorded without changing it. |
| initial GLB inventory pass | Non-recursive enumeration found only 1 top-level model | Replaced with recursive traversal; accepted inventory covers all 22. This was an incomplete probe, not a shell failure. |
| initial crowd measurement | Explicit `projectId:null` was rejected by current identity normalization; actor count stayed 25 | Discarded capture, used omitted default-project field, added exact 25/29/35 actor-count assertions and reran all ten cases. No discarded crowd sample appears in the report. |
| exec, first scoped task-kill query | `Get-CimInstance : Invalid query`, `HRESULT 0x80041017` | Shell quoting removed WQL quotes; used a literal task-owned PowerShell file matching only the measurement Node script. |
| interrupted measurement process | Original runner tree intentionally terminated; child command exited nonzero | Terminated only the task's Node/temporary Chrome tree, then reran corrected fixtures. Existing user Chrome was untouched. |

GPU baselines do not cover the installed UI, pending full-window layout, future residents, new species, cold-start safety or long-session stability. Those limitations are part of the report and proof gate, not unresolved environment failures. The account's Meshy balance/dollar quote is unverified; the proposal allows no new purchase without its own approval.

Cleanup: measurement server stopped with Ctrl+C (`write_stdin`, exit 130); this was an intentional stop after all captures, not a failed baseline. All measurement browser contexts were closed. The server is not left running.
