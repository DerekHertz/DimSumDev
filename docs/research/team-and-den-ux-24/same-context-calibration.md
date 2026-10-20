# Original/null calibration result: diagnostic repeatability failed

All six predeclared blocks completed in the same page/WebGL context with the original Claude Bao host active for both labels. Median-of-three differences pass5%, but the additional paired repeatability guard fails pair2. **Stop: no A/B/full60, no retry or art change.** The original failed60 acceptance dataset remains failed. This original-only result cannot accept the replacement.

The fresh quiet-host run started2026-10-20T22:12:39Z and ended at the raw recorded finishedAt; owned browser closed and server71338 stopped by22:16:58Z. Root then released the quiet condition. Full timestamp precision is retained in same-context-calibration-statistics.json. Frozen driver SHA256 fa9202d985e492b8ee384b1773f7920881312cc8a7df4e94f59945b835e741a3; raw SHA25684f17997b179e5cfee3599baa550b4777327133e7d241cf9d56907eaa7ba9b69. Every row/query/outlier is retained.

Each table entry is p50 / p95 in milliseconds. Animation is the sum of the three callback costs per frame; combined CPU aligns callback timestamps with rendered frames, so its p95 is not the sum of marginal p95s.

| Pair / label in capture order | GPU elapsed | Render CPU | Animation CPU | Combined CPU |
| --- | ---: | ---: | ---: | ---: |
| 1 A | 11.131904 /15.890432 | 12.3 /17.2 | 2.1 /2.9 | 14.5 /19.8 |
| 1 B | 11.601920 /16.041984 | 12.3 /16.5 | 2.0 /2.6 | 14.4 /19.0 |
| 2 B | 12.899328 /18.510848 | 13.0 /19.5 | 2.0 /2.7 | 15.0 /22.1 |
| 2 A | 11.019264 /15.536128 | 12.0 /17.3 | 2.0 /2.6 | 14.0 /19.7 |
| 3 A | 11.590656 /16.092160 | 12.3 /17.7 | 2.1 /2.7 | 14.4 /20.2 |
| 3 B | 11.430912 /16.073728 | 12.1 /17.3 | 2.0 /2.7 | 14.1 /19.7 |

GPU p95 A repetitions15.890432/15.536128/16.092160 → median15.890432; B16.041984/18.510848/16.073728 → median16.073728, **+1.1535%**. CombinedCPU p95 A19.8/19.7/20.2 → median19.8; B19.0/22.1/19.7 → median19.7, **−0.5051%**. Both GPU medians are below16.7ms, with0.809568/0.626272ms headroom; B's pair2 repetition itself exceeds that target. This is original/original headroom, not replacement acceptance.

Differences always mean `(B/A−1)×100`, independent of capture order. Pair1 GPU+0.9537%, CPU−4.0404%; pair2 captured **B then A**, GPU **+19.1471%**, CPU **+12.1827%**; pair3 GPU−0.1145%, CPU−2.4752%. In pair2 the earlier B block was18.510848GPU/22.10CPU, followed by A15.536128/19.70; the sequential B→A changes are−16.0701%/−10.8597%, a different denominator from the label comparison. The median guard passes and pair2 fails both additional absolute5% repeatability checks. The paired rule remains recorded and failed; it is not silently removed.

## Consistency and limits

All rows retain897–901 frames,299–301 GPU queries,29.96–30.00s measured frame spans, exactly3 callbacks per rendered frame in update/pose/update order and every callback assigned. Zero browser errors/writes/disjoint/pending queries.42actors/4visitors/6guests and one Claude Bao host; one active body/skeleton and unchanged selected parked counters. Camera world/projection matrices, root transform, scene resource counts and garden geometry match. Host pose/gesture deltas across warmup+sample/drain were1212–1219 each; skeleton deltas3636–3657. These counters include warmup/drain and are not sampled-frame callback counts.

GPU graphics/memory clocks were1755/9701MHz throughout, P0; temperature44–46°C, power82.99–85.83W, total device GPU utilization16–21%, memory utilization4–5%. Pair2 B utilization17–21% versus A16–19%; this is aggregate telemetry and cannot attribute frame cost or device busy time. CPU frequency/utilization/preemption were not recorded.

Per-frame calls were1537 in both pair2 blocks. Pair1 B reaches1544 and pair3 A1542, consistent with observable branch/visibility variation in the continuous garden; identical branch work is not proven from fixed callback counts. Those blocks still pass pair repeatability. Marginal animation p95 changes only2.7→2.6ms in pair2, while render p95 changes19.5→17.3ms; this localizes most recorded CPU shift to the render interval, without identifying whether CPU execution, scheduling, driver submission, scene phase or another cause changed.

Final pending count0 is recorded; per-query availability lag is not. Full camera/root transform is recorded; skeleton bone/pose matrices and framewise logical phases are not. Before/after logical clocks advance continuously, with no reset. Same-context dual residency changes cache/memory and cannot establish normal resource budgets. GPU elapsed is the same marker-interval metric; no physical GPU busy claim or causal proof follows.

An independent runner recomputed every GPU/combinedCPU p95, median and pair percentage directly from raw data without the existing arithmetic helper; verified callback assignment, sample/identity/context/parked/query guards and frozen hashes; all match. No code/tests/art changed during this capture. No further native capture ran. See the next-method draft for reviewable options; none are authorized by this result.
