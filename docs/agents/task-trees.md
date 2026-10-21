# Protected task-tree execution

The hierarchy is Bao (Claude) or Jiao (Codex), up to four role managers, and up to four runners per manager. It bounds the decomposition; it does not prescribe how many processes to start. A small task normally uses its owner alone or one helper, while required independent reviews still run. Configured owner/manager models keep planning and judgment; lower-cost runners do bounded work whose evidence their manager checks.

## Current architecture and this slice

`.claude/agents/*.md` owns role contracts and Claude model/effort settings. `scripts/codex-sync.mjs` generates `.codex/agents/*.toml`, adapting runtime prose while preserving tiers. Its existing mapping is Sonnet → `gpt-6.1-sol`, Haiku → `gpt-6-luna`, Opus → `gpt-6-astra`. The orchestrator and judgment roles use Sonnet/high; runner and scout use Haiku/low; SRE uses Haiku/medium. This change chooses no new owner tier. `.claude/skills/` generates `.agents/skills/`; `CLAUDE.md` and `.codex/runtime-guidance.md` generate `AGENTS.md`.

The host's opt-in structural slice adds fixed tree proposals, explicit revision approval, parent-scoped child starts, configured model routing, isolated worktrees and descendant cancellation. It shares the existing host admission, ownership, runtime allowlist, governance and process-resource checks. Native Claude Agent/Task delegation is disabled for tree runs. Runners in this slice are read-only checkers; they receive no commit, publication or child-delegation rights. Results remain evidence with `accepted: false`, rather than an integration or review verdict.

The existing bridge process policy remains `worker: 2`, `bao: 1`, `scout: 1`, shared across runtime identities. These are process classes, not tree layers. An owner plus one manager and one runner fits that policy. A busy request refuses admission; callers sequence work and inspect current state rather than raise limits or blindly retry. This slice does not release waiting parent sessions or implement the verified integration scheduler. Nonempty node dependencies are refused. It does not complete codex-residents/07–11 or enable the proposed 2-executive/4-manager/8-runner simultaneous capacity.

There is no production Codex adapter on the starting main branch. Codex identity tests through an injected adapter prove the host contract only. Live Codex execution remains unavailable until codex-residents/16 builds the disabled protected app-server adapter/shared policy compiler, den-mvp/72 proves the actual launch path, and codex-residents/02 independently reviews enablement. Registration is a separate gated change. The native per-turn workspace sandbox alone lacks credential-deny/read-root controls and is not a substitute for that work. The production resource launcher also requires Linux cgroups v2 and bubblewrap; native Windows cannot provide its live conformance evidence.

## API and approval

The existing ticket approval first records the task's owner. A session-authenticated `POST /trees/plan` then proposes `{ ref, runtime, project, scopes, nodes }` without starting a process. Root runtime must match its recorded owner. Each non-root node has `{ id, parent, role, outcome, inputs, scopes, dependencies, acceptanceCriteria, verificationCommands }`. `parent` names `owner` or a manager contract ID. The runtime and role's model/effort are resolved from trusted control recipes and frozen in the proposal, rather than accepted from a worker. Scopes must remain within the parent's approved scope; unknown parents, cycles, excessive depth/fanout and governed scope escapes are refused.

Review the returned complete revision. Session-authenticated `POST /trees` with `{ revision }` explicitly approves that exact revision and starts its owner. A later proposal supersedes an unapproved revision. Agent credentials cannot approve revisions or choose a new owner. A changed ownership epoch, disabled runtime or unavailable configured model refuses execution; there is no automatic runtime/model fallback.

Tree runs receive a separate private MCP capability for `tree.delegate({ nodeId })` and `tree.result({ childId })`. The token fixes the live parent; a request cannot supply another parent, task, model, scope or grant. Only a direct child of that approved revision may start, and the parent's trusted role must permit it. Live sibling write scopes must be disjoint. Each node gets its own worktree and admission attempt. Parent completion, cancellation and shutdown cancel descendants, including a spawn that lands after cancellation. Ended tree sessions cannot resume through the legacy conversation path. Replayed history is display-only and grants no execution authority.

`GET /trees` is session-authenticated. It contains the reviewed contracts and current node states; treat it as private task data. It is not a public replay feed. A process completion does not satisfy a required independent code/QA/security review, acceptance criterion, integration barrier or publication gate. Existing first-failure, one-attempt, correction-budget, scoped-test and user-merge rules still apply.

## Remaining dependency order

1. Extend the durable node record with immutable code candidates, criterion/check evidence and the existing independent review floor. Bind each verdict to its exact candidate and invalidate it when the candidate changes; a manager's raw completion never grants acceptance. Read-only runner evidence in this slice grants no code-leaf acceptance.
2. Add accepted-child barriers and explicit parent yield/wake transitions. Release a waiting parent's execution session, keep logical node identity and approved authority separate from attempts, and reconcile interrupted resource groups before any resume. Prioritize verification/integration so two worker slots cannot deadlock behind waiting managers.
3. Integrate accepted children in stable order on private parent branches through bridge-owned, journaled operations. Recover uncertain commits without repeating them; run combined checks and independent final root review before the existing delivery publication path.
4. Complete the disabled Codex app-server adapter and common policy compiler, then prove the actual protected launch path and independently review enablement. Fixture tests do not substitute for filesystem, credential, network, approval, resource, resume and cleanup conformance.
5. Measure mixed workloads within the current aggregate resource budget before proposing any higher live-capacity profile. The 21-node structural limit remains independent of those measurements.

The current implementation authorization covers reversible code work on these stages. It does not supply a Linux conformance environment or waive the existing separate enablement/user-merge gate. Dependency additions, account/credential changes, publication, owner-tier changes and unmeasured resource-limit increases retain their existing approval requirements; this slice adds none of those approvals. The complete-revision approval above is the existing codex-residents spec's explicit requirement (user story 10 and "no unapproved decomposition execution"), not a requirement to spawn every approved node.

## Lifecycle data for replay consumers

The bridge already appends `.scratch/_run/sessions.jsonl` and publishes agent state changes through `/events`. Tree records additionally live in `.scratch/_run/task-trees.jsonl`; proposals contain full contracts and must stay private. Neither JSONL file is a tamper-proof audit log. Replay validates records and never restores authority to signal a process or reuse a capability.

A visual consumer should project lifecycle records into a whitelist, rather than expose the journal, transcript, contracts or reports:

| Replay field | Source/meaning |
|---|---|
| `runId`, `agentId` | Bridge agent/run ID; do not use native session IDs as authority |
| `eventId`, `sequence` | Consumer source plus JSONL line ordinal, or its SSE sequence; identify the source because there is no global cross-store sequence |
| `timestamp` | Record `ts`; chronology is an observation, not proof of causation |
| `treeId`, `nodeId`, `parentId`, `layer` | Bridge tree metadata; layer maps depth 0/1/2 to owner/manager/runner |
| `role`, `runtime`, `model` | Trusted configured selection where recorded; distinguish it from model-reported usage |
| `kind`, `state` | Tree journal `proposed`, `approved`, `reserved`, `ended`, or session `spawn`/`end`; a reservation is not proof that a process started; no synthetic review approval |
| `taskSummary` | Omit by default; a separately redacted, bounded user-approved label only |
| `evidenceRefs` | Candidate SHA or explicit reviewed evidence reference when present; no raw reports, paths or prompts |

Do not emit tokens, credentials, raw task inputs, transcripts, shell commands, private native session stores or connection configuration. Missing model/review/evidence fields remain missing. Review visualization must wait for real candidate-bound verdict events; this slice does not invent them. A separate visual integration must verify its projection against actual lifecycle output before presenting it as a recorded run.
