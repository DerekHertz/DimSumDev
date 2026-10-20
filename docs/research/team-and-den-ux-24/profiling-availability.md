# Read-only profiling availability

Observed after calibration on 2026-10-20. No GPU capture, recorder launch, installation, settings change, environment/credential access or process-commandline collection occurred.

## Existing Chrome trace

A read-only streaming scan reused the preserved 173,809,893-byte original-only trace A. Within its two sample marks (30,018,735 trace microseconds), 43,218 of 53,542 duration-bearing renderer task spans contain numeric `tts` and `tdur` (80.7%). The 301 recorded CPU query issue intervals align through the existing clock anchor. Missing thread fields must stay missing; nested spans cannot be summed as independent CPU work. This trace contains only the low GPU-timing mode, so it cannot explain the high-mode shift in the later calibration.

The scout inspected field counts and numeric timing summaries only, without emitting event arguments or metadata values. The scan completed in 7.3 seconds and created no new capture. Chrome represents these timestamp/duration fields in microseconds; the observer's `performance.now()` values and converted GPU elapsed values are milliseconds. [Chrome DevTools trace types](https://chromium.googlesource.com/devtools/devtools-frontend/+/b88894b14f63f84c460f66cff8918b2b4d079eae/front_end/models/trace/types/TraceEvents.ts) define the microsecond fields.

## Windows read-only probe

The reviewed file-based helper at the external `ticket24-profile-availability/` directory ran once, using literal arguments. `availability.json` records the observation at 2026-10-20T22:23:28Z:

| Source | Observed availability |
|---|---|
| `Win32_Processor` | CurrentClockSpeed 3801, MaxClockSpeed 3801, 16 logical processors |
| Formatted Processor Information aggregate | ProcessorFrequency 3801, PercentProcessorUtility 44, PercentProcessorPerformance 119, PercentIdleTime 67 |
| Existing System32 WPR file | Version 10.0.26100.9711 |
| Existing Windows Kits WPR file | Version 10.0.26100.3916 |

The WPR executables were not launched; recording capability, permissions and privacy are untested. They are excluded from the proposed own-browser capture. Counter observations are one availability sample taken after the quiet condition was released, not historical evidence about the failed runs.

`Win32_Processor.CurrentClockSpeed` is an MHz value sourced from SMBIOS; it must not be presented as a precise instantaneous per-core frequency. [Microsoft's class documentation](https://learn.microsoft.com/windows/win32/cimwin32prov/win32-processor) specifies that source. Processor Information exposes distinct performance and utility counters, rather than interchangeable CPU percentages. [Microsoft's PerfLib consumer example](https://learn.microsoft.com/windows/win32/perfctrs/using-the-perflib-functions-to-consume-counter-data) identifies their counter types. A later logger must retain names, units/windows and sampling times without inventing instantaneous frequency or causal attribution.

## Finding

An own-browser CPU task/thread-time diagnostic with non-sensitive CPU counter telemetry is feasible without installing a profiler or changing the machine. It can distinguish some workload/wall-time hypotheses if relevant modes recur. It cannot promise exact preemption attribution, driver ownership or GPU busy time. The supported capture proposal is in `cpu-profiling-proposal.md`.
