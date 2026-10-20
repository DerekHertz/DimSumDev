# 22: Cast inventory, reference baseline and proof proposal

**Inventory and baseline delivered; proof plan and budgets approved by the user on 2026-10-19.** The user selected the existing-Meshy-credit route. No production assets or generation tasks started. The router stayed stopped.

- [Costed two-character proof plan](./two-character-proof-plan.md): red-panda engineer + cloud-dragon technical writer; proposed 22–36 focused hours, 12k triangles per complete actor and optional 300-credit existing-balance ceiling; no new purchase.
- [Performance baseline](./performance-baseline.md): RTX 3060 Ti, ten real-GPU scenarios, 3,590 render samples; approximately 29.83–30 fps under the existing cap. Actual scene canvas is 980×483 within the 1440×900 window; not the future full-window canvas.
- [Asset inventory](./asset-inventory.md): all 13 approved principal designs mapped against 25 current resident identities, visitors, legacy roles and 15 additional ambient bodies. Includes body/rig/outfit/tool/portrait reuse limits and current load/fallback behavior.
- [Validation and failed/discarded calls](./run-log.md): existing garden guards passed; bad crowd fixture was discarded and corrected; no new dependency or application-source change.

Source baseline: `8b3172d` on `codex/cast-inventory-22`. Installed den: v0.1.7 / `14b615d`. The fetched 04 merge is terminology-only; full-window 04 remains in review on the board and its approved shell is absent from this base. Re-baseline after the actual shell and 03 seats before approving asset performance. This does not block inventory or budget discussion.

The cost/budget gate for 22 is accepted. Approval does not start 23: it retains its 03/04 dependencies unless the user approves a separate preparation slice. Part 2 of 04 is necessary for final in-den fit/performance sign-off, rather than for standalone model generation/rigging. Rollout 24–34 still waits for the two-character proof and a new costed approval.
