# H15 narrow settlement proof: stopped on architect-added harness assumption

THROWAWAY ONLY. Never merge/cherry-pick this branch. Production remains 993523f244483f554079ece4ebb07c4c9ff8e93c.

Preparation began03:53:16UTC; sole run started2026-10-21T03:54:54.117Z, finished2026-10-21T03:54:57.339Z, elapsed3219.782338ms, exit1; no timeout/signal, no retry or correction. Exact command: node docs/research/team-and-den-ux-36/prototype/h15-run.mjs. Exec session76459. Literal argv/shell:false and shared60000ms owned-group watchdog unchanged. Owned group249: receiptESRCH; independent offline cleanup probeESRCH.

## Verdict and responsibility
The architect added an unnecessary equality assertion comparing current live identities to the initial fixture identities. The unchanged busyRows/applyLive call legitimately changes the live reference within identity and assigns matching current home owners. H15 stopped on orchestrator: initial reference null versus current h13/settle/orchestrator. This is an avoidable harness mistake introduced in H15, not evidence of a product ownership bug. The corrected settlement contract did not complete.

A second new frozen-initial assertion compares current homePlace to initial homePlace; it was not reached. Stable original resident lookup by original.id and current owner equality are the requested ownership checks. Exact unexecuted removal proposal is /tmp/36-h15-unexecuted-contract-proposal.txt and handoff36-architect-5.md. No executed source was fixed after failure.

## Executed evidence and limits
PASS before stop: all32 initial visible/owned and full local witnesses; visitor independent skeleton/live ref/distinct start/first motion/leg deformation/owned arrival/removal32; real product outing; newcomer protects corridors; disconnected return reproof rejects at250000external queries, retains existing safe return and body; restored product physically reaches its owned home.
Captured immediately before new assertions: 32original residents, 32visible, 32current home owners equal current identities. All32 activity/live/routine/identity/home ownership plus lease registry captured. All32 have routine:null at this instant;28live refs were legitimately rebound. Selected owned return predicate and original-resident count passed; first original identity check failed. Settlement inspect after the new assertions, disconnected-destination stage, and unchanged H11 safety target all UNRUN. No full feasibility/production acceptance.
102completed frames,3333footprints,172swept segments,52800pairs,172actual deformed-vertex measurements/4128vertices passed before stop. 51operations;270387total external calls including independent oracle calls;max transaction250000. Max work candidates18/routes11/nodes11223/exitChecks273/queries250000. Fixed129/32/16384/32768/250000/cache32768 and75%/93.75%/100% phases unchanged.

## Preservation and provenance
Only new H15 caller, driver, loader, provenance and this result added; all20existing prototype files unchanged. Static reversible replacement/syntax checks passed before the sole run; no behavioral preflight. Original fixture exact slice including trailing newline remains0ca14f7f48a3fb1713e5469efb71150df78610fcfd75c14d7abd1df250ccaed5. Original repository tests, geometry oracle, overlays, envelopes/margins, routing/certificates/traveller, update order and remaining stages unchanged.
Offline receipt verification:33file hashes;33loaded module records/31file-source records checked; mismatches:[]. Raw local artifacts prefix:/tmp/36-h15-settlement-contract-20261021-035316 (.log,.receipt.json,.cleanup.json,.diagnostics.json,.modules.jsonl). No raw captures uploaded.

## Failed calls and environment
One failed call: sole full H15 driver exit1, AssertionError: original resident keeps identity orchestrator, h15-proof.mjs:90:1076. Stopped; no retry, post-failure source change, functional import or further test. No other command failure, permission refusal or execution environment blocker observed. Mandatory start auto npmci added138/audited139 and reported1high vulnerability; no separate install/audit remediation. Router/services/installedden/Bao/ticket17/main unchanged. No usage/spend claim.

Next: orchestrator/user review stopped evidence and exact unexecuted contract proposal. Production implementation, assembled32/42 scene evidence and independent review/QA/user visual remain separate future work; no implementation estimate asserted from this failed proof.
