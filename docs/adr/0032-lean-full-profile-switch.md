# One lean/full profile switch sets the org limits, tiers and verifier count

**Status:** proposed (trust-ladder/01). The user accepts it by merging the PR that builds it.

The org limits were tuned for a Pro plan, so the user could not run the den harder, and had no one-tap way to cut usage when it burned too fast. We add a single **Profile**, `lean` or `full`, that sets concurrent workers, the leaf (Minimum) tier, the verifier count, the verifier loop cap and ticket-size guidance together, mapped onto the existing Org limits, Minimum tier and Verify depth.

**Decision.**

1. **One setting, two values, default `full`.** There is no third value and no per-knob override. The bridge holds the choice in a file in the den's state folder (`profile.json`); a missing or invalid file reads as `full`.
2. **The user flips it by hand.** A token-gated `POST /profile` changes it; `GET /state` reports it with the values it yields. The flip takes effect on the next run without a restart: the host reads the profile on every admission.
3. **No automatic switching on usage.** `usage-watch` stays an observer that reports usage and never blocks or flips the profile. The den shows the usage reading beside the profile so the user decides when to flip (the UI is trust-ladder/16).
4. **The wall is identical in both profiles.** The resource-group classes in `limits.json` (memory, CPU, tasks, storage), `governance.json`, `ceilings.json` and the connections catalog do not depend on the profile. The profile table holds no limit of the wall, and a test pins that `limits.json` is untouched by a flip.
5. **The values.** Lean keeps today's behaviour: 2 workers, Haiku leaves, 1 verifier, tickets split above 150k tokens. Full starts at 2 workers until the concurrency raise (trust-ladder/15), with more than one verifier for risk-path and UI tickets and no size guidance beyond one outcome per ticket. Full's leaf tier, verifier loop cap and verifier counts are first guesses, tuned during the first full-profile runs.

**Consequences.** Until trust-ladder/15 lands, the two profiles differ in tier and verifier count but not in concurrent workers. The verifier itself (trust-ladder/02) and the dispatch paths that read the tier and verifier count come later; this change only holds and reports the values. Automatic switching is a possible later decision and would need its own ADR.
