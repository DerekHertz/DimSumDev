# Standalone Codex evidence — 2026-10-21

Production use remains gated. Implementation source candidate `817c76e` supplies an unregistered standalone Codex CellRuntime over the bridge's existing protocol, lifecycle, resource and hierarchy interfaces. The single approved offline diagnostic failed before any native shell probe produced results. No live Codex model, headless Codex hierarchy or production enablement is proved by this record. Registration remains disabled; independent final-candidate review and publication checks are recorded separately by the relay.

## Preserved work and ownership

- Original unpublished hierarchy: `d0017d902948aef1b39aaac29d3a047dc6729a33`, `codex/tiered-delegation-rules`, recovered from `D:/codex_projects/2026-10-21/task-2/hierarchy`. Its earlier independent passes cover that historical candidate, not subsequent adapter changes. Its workflow tests use injected runtimes; its kernel checks use Node canaries.
- Original disabled adapter: `cea52bb8e0dda352f830332b2a7d108acc97a734`, `codex/disabled-app-server-adapter`, preserving the hierarchy merge and the reviewed protocol/profile stages. Original Windows checkouts and uncommitted WIP were preserved. Their Git worktree pointers are Windows paths; history was imported into a separate Linux worktree rather than repaired or reset.
- Current work: `codex/standalone-codex`, `/home/dhertzell/dimsumden/.worktrees/standalone-codex`. Root coordinates and owns this evidence directory; one developer owns the compiler/runtime/host interfaces. QA authored `c64db4d`; implementation checkpoint `5c5ea4f` follows it. Current `origin/main` was merged at `4d692617` without changing main's dirty checkout. PR383 and the separately merged replay UI are outside this change's implementation scope.
- The recovered handoff said the Claude smoke had not run. No later result receipt was found during reconciliation. It was not repeated, and it is not Codex evidence.

## Exact failed native attempts

Historical candidate `741bf56d95d5a70818b86d4fdd63b090d9b9f950` failed its corrected offline shell canary with exit 1, no diagnostics and no probe results. Its original receipt was pruned by an earlier cross-platform worktree operation. The recovered receipt is explicitly a reconstruction; no original-byte integrity claim is made. The earlier attempt's missing-helper diagnostic and this correction's empty output are retained in `docs/agents/codex-permissions.md`.

Derek then explicitly approved one additional instrumented offline diagnostic. Security passed the exact wrapper SHA-256 `4afe035873aef8a5e6c327b2769dbcf59c3e77827e52bace7465baed42b3c7be` against the seven-file dependency closure at `5c5ea4f0bc153154248ce401e7ac106358d79642`. The preserved `diagnostic-script.mjs` has those same bytes. Its default, source-check and fake self-test modes run no native canary. Do not invoke its native mode without a new explicit allowance.

The [captured receipt](diagnostic-receipt.json) records the command, environment and observed output. Codex 0.163.0 exited 1 after 780 ms with zero stdout/stderr bytes and no probe results. The exact task-only scope `den-run-codex-profile-618f6902f95003c9.scope` settled, independently rechecked by the wrapper. Streams drained; dummy markers remained intact; the listener saw zero connections. Cleanup of the launcher's internal preflight probe is inherited from the launcher and was not independently observed by this wrapper. No model/account/auth call or retry was made. The native failure stage remains undetermined.

A subsequent read-only filesystem check confirmed the diagnostic's exact disposable fixture `/tmp/den-codex-profile-task2-G2CT0K` was absent after confirmed group settlement.

The native helper was a regular executable (mode 0755) with SHA-256 `399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215`; Node was v22.23.3, Linux x64. Authentication contents were not inspected or used.

## What the checks establish

- Preserved protocol/profile/model fixtures: 44/44 passed at `4d692617`; fixture evidence only.
- QA specify `c64db4d`: 35 unchanged Claude compatibility cases passed; eight missing-compiler and three Codex five-hour-reader assertions failed behaviorally; the Claude guard assertion passed. No setup failures or skips.
- Developer checkpoint `5c5ea4f`: six literal files reported 236/236 passing with no skips, including unchanged Claude output/error digests, Codex no-query admission/direct/resume tests and fake-launcher canary cancellation/cleanup tests. This is not native conformance.
- Developer implementation source `817c76e`: 12 literal affected files reported 289/289 passing with no skips. After adding one detached-Git ownership regression, the runtime file passed 10/10; no product source changed after the 289-test run. Real Node subprocess fixtures substitute Codex and the launcher; they do not prove native Codex/kernel/model execution.
- Final adapter/affected-caller checks, independent code review, QA, security, required build and publication checks must identify the final candidate. Historical reviews do not satisfy them.

The developer's exact 236-test command was `timeout 180 node --test --test-concurrency=2 apps/bridge/agents/effective-role-policy.test.mjs apps/bridge/agents/host-codex-usage.test.mjs apps/bridge/agents/host-runtime-identity.test.mjs apps/bridge/agents/codex-permissions-canary.test.mjs apps/bridge/agents/claude-adapter.test.mjs apps/bridge/agents/claude-tree-adapter.test.mjs` (exit 0, 13,200 ms). Its output is retained in the development transcript, not a separate log artifact.

## Remaining gates

Ticket 16 builds the disabled adapter/shared policy integration. Tickets 72 and 02 require actual launch-path conformance for native tools, filesystem/credential/network restrictions, approved connections, effective models/tools, approval handling, exact resume, resource limits and cleanup. Actual Codex delegation must return results through parent acceptance/handoff and exercise failure/cancellation; injected runtimes cannot satisfy this gate. Registration requires the separate reviewed user-merge change after those protections pass. This task authorizes no merge or deployment.

The approved diagnostic allowance is exhausted. The smallest remaining live step is an explicitly reviewed, materially informative bounded native startup diagnostic, retaining the same protected profile and task-only slice; it must distinguish wrapper/helper startup and inner sandbox execution. No additional native attempt is authorized by this record. Safe code work and review may continue while native execution is held.

## Failed calls and limitations

- Reconciliation lookups guessed absent files/SHAs (`.agents/skills/openai-docs`, `d0017d9`, `codex-rpc.mjs`, dated handoff glob, a prototype runtime path); tools reported `No such file or directory`, `unknown revision`, `malformed object name`, or GitHub HTTP 422. Correct paths and the unpublished Windows repository were then found; no source was discarded.
- Ordinary `git fetch` and QA `agent-start` hit read-only `.git` metadata. Scoped sandbox escalation succeeded. The Windows checkout's LFS status scan failed with read-only `lfs/tmp`, `Broken pipe` and `clean filter ... failed`; its state was preserved. The Windows adapter pointer was invalid under Linux; immutable commits were imported instead of altering that checkout.
- Jevgrep reported `cache_unavailable` and truncated broad context. Narrow source reads supplied the needed detail. A bounded cross-session search timed out with partial results; no missing result was treated as proof of absence. Some inventory/no-match commands exited nonzero, and a truncated listing reported `Broken pipe`; these were discovery limitations.
- Two proposed diagnostic wrappers failed independent review before execution (incomplete source pins/timeout/exit handling, then unbounded cleanup and a slice-variable scope error). The final reviewed wrapper fixed those findings and passed fake-only checks.
- Before the controlled entry existed, three new RED test calls accidentally selected the real task-slice preflight. Each failed before launch: `could not set the limits of den-agents-codex-task2.slice: Failed to connect to bus: No data available`. The test path was stopped, given a missing-capability assertion before invocation and separated from the default launcher. No Codex/resource group launched; no disposable canary roots remained.
- The single user-approved native diagnostic exited 1 as recorded above. This is failed validation, not passing containment or production evidence. No retry followed.
