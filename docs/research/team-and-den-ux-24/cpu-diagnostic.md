# Prepared CPU/scheduling diagnostic

Preparation only. Fresh user Ready and a new capture handoff are required before running the native command below. No new Chrome/GPU capture or server was started during preparation. Original failed60, fresh-context false difference and same-context pair2 failure remain unchanged; this observer cannot accept Bao.

## Preregistered run

One six-block original/null sequence **AB/BA/AB**, same page and WebGL context,10s warmup+30s sample per block. Existing42actor/4visitor/6guest meeting-light fixture, body/camera/parked-rig guards and unchanged elapsed/render/animation arithmetic remain. Query frequency, availability polling and GL calls are unchanged; only IDs and CPU issue/availability timestamps are added. Every row/query/outlier stays, including failures. Scene clocks remain continuous; before/after logical phase and draw/callback counts are retained. Exact framewise skeletal/branch equivalence remains unproved.

Native operation deadline410s leaves cleanup reserve inside the420s wall bound. The shared64MiB saved-output cap includes initial frozen helpers/plan, counters, current raw rows, structural spool, renderer log and reserved64KiB status. Both spool and final file count while they coexist. Stop at cap/deadline/data loss/missing clock marks/buffer95%; preserve partial output and do not retry. A durable capture-attempt marker prevents a second attempt even after interruption. Startup/shader and trace overhead are diagnostic costs.

Calibration's existing`nvidia-smi/clock()` calls are absent from this CPU diagnostic; there are no GPU clock/device-utilization polls or SystemInfo GPU inventory. Consequently there is no GPU-clock telemetry for this run, and its rows cannot assert fixed GPU clocks. The timer-query and render/animation collectors retain their calls and arithmetic.

Root reviewed the exact logger before its one10s read-only functional preflight. Both samples succeeded at5.016s spacing; query wall times were1202.4194ms and289.302ms. Because this overhead could perturb the target, root changed placement before capture: **exactly two pre and two post samples**,5s cadence, outside every warmup/sample, awaiting helper process and stdout closure. There is no live counter process during the six blocks; runtime guards and a test enforce this. No new reader/tool/cadence investigation or second native probe occurred.

Counters are raw string values from `Win32_PerfFormattedData_Counters_ProcessorInformation`, aggregate`_Total`: `ProcessorFrequency`, `PercentProcessorUtility`, `PercentProcessorPerformance`, `PercentIdleTime`. They retain provider field names rather than being renamed to physical core frequency or interchangeable CPU percentages. Formatted provider update windows are unspecified here;5s is the consumer cadence. The reported3801frequency value is not proven instantaneous/effective per-core frequency. Utility, performance and idle have different reference meanings; no derived CPU-busy or per-frame frequency claim is permitted. Optional provider`Timestamp_*`/`Frequency_*` fields were absent and stay missing. Each acquisition keeps UTC+Stopwatch begin/end/query-wall-time; the driver also records received UTC/monotonic time and pre/post helper lifetimes. These are coarse bracket observations only.

## Structural task log and clocks

Requested trace categories: `toplevel`, `devtools.timeline`, `v8`, `blink.user_timing`. No GPU/service categories, screenshots, input, args, stacks, environment or process command lines are persisted. Chrome's supported stream is read in64KiB chunks; the retained parser's nested/escaped JSON state machine is adapted with a1MiB per-event bound. Full trace JSON is never assembled in JavaScript memory or saved. Chrome still owns its internal trace buffer;95%buffer usage or reported data loss stops the run.

Structural selection is predeclared: every`X` event with any selected category and finite pid/tid/ts, plus the two named sample marks. Save names/categories/phases/IDs and every present numeric`ts/dur/tts/tdur`, including zero/negative durations and missing thread times. No selection by duration, metric outcome or convenient mode. A numeric-only spool avoids relying on trace event order; after both marks identify the page's renderer main thread, every qualifying span on that pid/tid goes into the final NDJSON log, including spans outside sample boundaries. Other own-browser threads in the provisional spool are excluded solely by identity; the spool is removed only after successful finalization. Missing`dur/tts/tdur` counts remain explicit.

Each complete timing row is saved **before** validation or fallible trace finalization. Partial finalization retains raw rows and the numeric spool/final prefix. Deadline cleanup attempts a bounded partial timing-row snapshot, ends active tracing/closes acquired IO, kills only the owned counter helper if necessary, then closes its owned BrowserServer; a stalled/rejected close kills only the retained owned browser child handle. Parent owns/stops the retained-build server in its capture handoff. No service or unrelated process/window control is used.

Align trace microseconds with page milliseconds by`traceUs = sampleStartTraceUs + (pageMs - sampleStartPageMs)*1000`. Keep both start/end marks and report end-anchor residual; page`timeOrigin`, UTC/now and driver/CPU UTC-monotonic anchors allow coarse bracket placement. CPU acquisition windows and page-clock precision limit alignment. For each query report all enclosing span counts and the outermost enclosing renderer task's wall/thread durations; do not sum nested task CPU durations or impute missing`tts/tdur`. Elapsed GPU queries do not locate absolute GPU execution or physical busy time. If no high mode recurs, report that and stop without a cause. No A/B/full60 follows.

## Frozen artifacts and future invocation

Authoritative final directory: external`ticket24-cpu-diagnostic-bracketed/` under the existing visualization root. Earlier`ticket24-cpu-diagnostic/` contains the preserved read-only logger preflight and a superseded preparation candidate;`ticket24-cpu-diagnostic-ready/` is also a superseded uncaptured preparation candidate. Neither is an alternative capture recipe. `cpu-diagnostic-receipt.json` records exact final hashes,62retained build-file proofs, all six historical dataset hashes and calibration raw hash. No rebuild or production/art edit occurred.

After fresh Ready, parent starts only the retained server in this worktree:

```sh
node docs/research/team-and-den-ux-24/same-context-server.mjs --serve-retained
```

Then, **require_escalated first**, run exactly one file-based native command (literal paths/arguments):

```sh
timeout 420 cmd.exe /c 'D:\NodeJS\node.exe' 'C:\Users\Derek\.codex\visualizations\2026\10\19\01a15689-f776-7ab1-8ca6-13d1dbc49206\ticket24-cpu-diagnostic-bracketed\native-cpu-diagnostic.cjs' 'C:\Users\Derek\.codex\visualizations\2026\10\19\01a15689-f776-7ab1-8ca6-13d1dbc49206\ticket24-cpu-diagnostic-bracketed' --ready-confirmed
```

Parent must stop its own port4425server in a finally path and release quiet after completion/failure. Driver owns its browser/logger/trace resources. No router/service actions. Preparation+analysis combined limit remains2focused hours; parent carries the remaining wall budget into the capture/analysis handoff, reserving at least45minutes for analysis. No native capture authorization is implied by preparation passing.

Focused verification: `timeout 300 node --test --test-concurrency=2 docs/research/team-and-den-ux-24/cpu-diagnostic.test.mjs docs/research/team-and-den-ux-24/same-context-calibration.test.mjs`; independent runner repeats focused syntax/tests and checks the final frozen hashes. The CPU logger itself was proved by the single read-only preflight, not a browser run.
