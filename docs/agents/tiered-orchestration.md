# Current verification

Final integrated candidate `660240a`: 275 covering tests and 4 native sandbox canaries passed. Both tiny live provider smokes passed with one lead and one bounded implementer each. [Final live traces and settings](evidence/live-tiered-2026-10-24/README.md#final-integrated-candidate). Earlier environment failures below are historical; the user bus was accessed through approved host execution without weakening agent sandboxes. Independent Standards/security and Spec reviews passed.

# Tiered dispatch

The bridge's existing `POST /tasks`, `POST /agents` and internal `host.start()` accept optional `execution` and `orchestration` objects. Dispatch remains token-authenticated, admitted, sandboxed and resource-limited. No dashboard, account settings, automatic merge or deployment is added.

A task without a role defaults to one developer. Bao/Claude and Jiao/Codex now receive a bridge-owned `delegate` tool and can choose when work needs delegation. Simple work uses one implementer. Coordination can use a manager, which can delegate focused children. Leaves receive no delegation tool. Native child tools remain disabled in Codex and denied in Claude so every child uses the same scheduler, admission, routing, cancellation and records.

## Invocation mappings

| Tier | Claude model / reasoning | Codex model / reasoning |
| --- | --- | --- |
| bounded | `haiku` / low | `gpt-6-luna` / medium |
| standard | `sonnet` / medium | `gpt-6.1-sol` / medium |
| hard | `opus` / high | `gpt-6-astra` / high |

Developers, technical writers and SRE default to bounded. Architects and security default to hard; other roles and explicitly requested managers default to standard. Task overrides take precedence. Hard tier requests and explicit model/reasoning overrides require a reason. Difficult implementation, debugging or integration should request standard or hard with that reason, rather than inherit the bounded default. This is an explicit routing policy, not an automatic semantic task classifier.

Supported reasoning overrides: Claude low/medium/high; Codex low/medium/high/xhigh, further restricted by the app-server's discovered model catalog. Unknown models, tiers and reasoning fail closed. Codex checks the actual account catalog before creating a thread, verifies its model acknowledgement and disables provider model fallback. Direct adapter callers without `execution` retain their existing recipe behavior.

Standard is the only enabled speed. Other requests, including Fast, are refused explicitly; no model is changed to satisfy a speed request. Claude receives invocation-local `fastMode: false`, an empty availability fallback chain and `switchModelsOnFlag: false`; Codex receives private `service_tier = "default"` and `serviceTierForTurn: "default"` on turn start. Claude aliases resolve through the installed CLI; the observed model remains separately recorded by existing model events. Account availability and actual live settings still require a live smoke test.

Sources: [OpenAI speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed), installed Codex app-server TurnStartParams schema (`serviceTierForTurn`), [Claude model configuration](https://code.claude.com/docs/en/model-config), [Claude speed configuration](https://code.claude.com/docs/en/fast-mode).

## Autonomous tool path

Claude receives `mcp__delegation__delegate` through a private, run-token-authenticated MCP configuration. Its invocation-local role definition retains the trusted role prompt, tool list and skills and adds that one tool. This role overlay is necessary: the native CLI hides an MCP tool excluded by a role's tool list, even if `--allowedTools` names it. No role file or account setting is rewritten.

Codex receives the same tool schema as an app-server dynamic function. The adapter accepts only `item/tool/call` for that function on the current thread and turn; its callback is bound to the spawning run. Native collaboration stays disabled. The orchestrator desk key resolves to the chief-of-staff recipe, so Jiao can receive a first request without requiring unsupported Codex send/resume capabilities.

The bridge validates the caller, provider, project, role, stable issue key, settings and canonical file scopes. It creates a focused task through the existing board service, assigns its provider lead, forks the caller's committed HEAD through the existing workspace code, and enters the existing admission transaction. No history, token, provider override, new grants or arbitrary parent identity can be supplied by the model. Managers cannot widen their admitted file scopes. Live leaf work cannot overlap anywhere in the delegated run.

A delegation call waits for the child to finish, then returns its state, bounded report, commit, branch, settings and measured usage. The manager integrates the returned commit in its own worktree and runs affected checks. Parent cancellation/exit cancels descendants, including pending spawns; children also have a five-minute deadline. Completed issue keys return a reuse instruction instead of launching duplicate work. Two failed children for one issue stop further repair and require a root-cause, uncertainty and options report. This limit is shared across managers under the same lead run. User publication and delivery review gates remain in place.

The tool accepts `kind: "implementer"` or `"manager"` from a lead and `kind: "child"` from a manager. The bridge fills the provider, project and actual parent. `issue` is a stable work identifier across repair attempts. Other brief and execution fields match the API examples below. Simple direct tasks still launch one implementer with no delegation capability.

## Focused hierarchy

A manager request needs `kind: "manager"`, a coordination `reason`, a focused `task`, and nonempty lists of `files`, `constraints`, and `acceptance` criteria. A child uses the same brief with `kind: "child"` and `parent` set to the manager's returned agent ID. Unknown fields, including history, are refused. Brief strings are bounded and checked for secrets.

```json
{
  "role": "developer",
  "runtime": "codex",
  "text": "Coordinate independent formatter and documentation work",
  "orchestration": {
    "kind": "manager",
    "reason": "Two separate changes need integration",
    "task": "Coordinate the changes and integrate returned evidence",
    "files": ["formatter.mjs", "README.md"],
    "constraints": ["One implementation owner per file; reuse child evidence"],
    "acceptance": ["Affected tests pass; required integration and security gates pass"]
  }
}
```

Use the returned manager ID in a subsequent child request. No other hierarchy members launch implicitly. Claude managers belong to Bao; Codex managers belong to Jiao. Autonomous dispatch records the actual delegating run ID as parent; manual dispatch retains the logical lead parent. A live lead has at most four managers, each with at most four live children. A child cannot manage another level, cross providers/projects, reuse a live sibling's task or overlap its file scope, including ancestor/descendant paths. A stopping, releasing or ended manager cannot receive children. Manager stop/exit cancels children through the existing bounded shutdown sequence, including a child whose spawn is still pending.

The existing lower hardware cap remains: two worker sessions globally across managers, providers and projects, plus the existing single reserved lead slot. These are independent of the four-by-four shape ceiling. Admission reserves synchronously before awaiting a process, so parallel requests cannot each claim a separate per-manager cap. A full host refuses dispatch with 429; it does not silently queue or launch a full tree.

## Reviews, repair and evidence

Existing delivery floors select required reviewers from type and changed paths. They preserve mandatory correctness, security and candidate-bound integration gates; this change does not carry a passing verdict to an unreviewed commit. Runtime instructions scope minor-fix verification to affected tests and changed areas and prohibit repeating completed child investigations. `MAX_BOUNCES = 2` already pauses automatic repair; only explicit user Resume opens another bounded round. Runtime instructions require a root-cause/uncertainty/options report at the repair limit and stopping at acceptance, with optional improvements separate.

Existing agent snapshots, spawn/end session events and run records now include `execution`, `orchestration` and `parent`. Validated spawn metadata survives replay. Delegation and escalation reasons are recorded in those objects. Existing measured token/cost fields are retained; null or absent usage means unknown, never zero.

[Captured host execution trace](evidence/tiered-orchestration-mocked.jsonl): a Codex standard manager plus two bounded children, three requested processes total and at most two live at once. This is mocked host evidence. Separate adapter tests exercise the real runtime/protocol code against a stub app-server and verify selected model, reasoning and Standard service tier at thread/turn invocation. They are not live provider evidence.

## Verification limits

Both production runtimes fail preflight in this session: the systemd user bus is unavailable (`Failed to connect to bus: No data available`). No live model call was attempted past that gate. Authentication, quota and live model availability remain unverified.

The unchanged real-native no-children canary also fails before any model request because the enclosing session's app-server socket directory does not satisfy the native sandbox's user-owned mode-0700 requirement. Mocked protocol tests and production-path stub tests pass independently. Restore a supported host environment and rerun the native canary and one tiny bounded provider smoke per provider before claiming production readiness.

## Changed files and verification record

Baseline: `706466b` on `main`. Implementation branch: `codex/tiered-orchestration`. One implementer; no specialist agents launched.

- Policy and lifecycle: `apps/bridge/agents/orchestration.mjs`, `host.mjs`, `sessions.mjs`, and `apps/bridge/server.mjs`.
- Provider invocation: `apps/bridge/agents/claude-runtime.mjs`, `claude-adapter.mjs`, `codex-runtime.mjs`, `codex-adapter.mjs`.
- Focused tests/fixtures: `apps/bridge/agents/orchestration.test.mjs`, `host-orchestration.test.mjs`, `claude-adapter.test.mjs`, `codex-runtime.test.mjs`, `codex-adapter.test.mjs`, `codex-stub.mjs`.
- Deliverable: this document and `docs/agents/evidence/tiered-orchestration-mocked.jsonl`.

Final covering command (exit 0; **419 passed**, no skips):

```sh
DEN_TIER_TRACE=/tmp/den-tier-execution-trace.jsonl timeout 300 node --test --test-concurrency=2 apps/bridge/agents/orchestration.test.mjs apps/bridge/agents/host-orchestration.test.mjs apps/bridge/agents/codex-runtime.test.mjs apps/bridge/agents/claude-adapter.test.mjs apps/bridge/agents/codex-adapter.test.mjs apps/bridge/agents/host-tree.test.mjs apps/bridge/agents/host-capacity.test.mjs apps/bridge/agents/host-cancel-handover.test.mjs apps/bridge/agents/host-runtime-identity.test.mjs apps/bridge/agents/host-sessions.test.mjs apps/bridge/delivery/plan.test.mjs apps/bridge/delivery/floor.test.mjs
```

Additional integration command (exit 1; **30 passed, 1 environment failure**, no skips):

```sh
timeout 300 node --test --test-concurrency=2 apps/bridge/agents/claude-process.test.mjs apps/bridge/agents/claude-runtime-host.test.mjs apps/bridge/agents/host-runtime-contract.test.mjs apps/bridge/agents/codex-no-children.test.mjs
```

The failing test is the unchanged real-native `codex-no-children.test.mjs` canary described above. The other integration tests exercise the Claude process path and shared host/runtime contract using fixtures. Syntax checks for every changed `.mjs` file and `git diff --check` exited 0. The systemd preflight probe command exited 0 while reporting `{ok:false}` for both providers; that is a blocker, not a successful live smoke.

Next action: verify on a supported host before publication. No push, PR, merge, deployment, dependency or account-setting change was performed. Optional future work: account-aware Fast-speed support.


## Autonomous completion evidence

The follow-up closes the missing model-directed path. Additional files: `apps/bridge/library/servers/delegation.mjs`, the shared `den.mjs` transport, `apps/bridge/agents/autonomous-delegation.test.mjs`, `autonomous-claude-stub.mjs`, `host-managed-tools.test.mjs`, and `fixtures/claude-managed-tools-probe.mjs`.

- [Claude trace](evidence/autonomous-delegation-claude-mocked.jsonl): Sonnet/medium lead, Sonnet/medium manager, Haiku/low child.
- [Codex trace](evidence/autonomous-delegation-codex-mocked.jsonl): GPT-6.1 Sol/medium lead and manager, GPT-6 Luna/medium child.

Both traces come from production host/runtime/transport code using provider stand-ins. The model stand-ins invoke the real managed tool, the child writes and commits a file, the manager cherry-picks that commit, and the test verifies the integrated file on the manager branch. Each run starts three requested processes; none starts a full tree. These are mocked provider results, not live provider success.

The additional guard tests verify two failed children stop repair, completed work is not repeated, parent stop settles the waiting tool, global capacity is shared, scope/settings/identity violations start no process, leaves lack delegation, and foreign/stale Codex tool calls never reach the callback.

A native Claude CLI probe against a local fake API verified `mcp__delegation__delegate` was advertised while `Agent` was absent. It made exactly one local API request and no provider account request:

```sh
node apps/bridge/agents/fixtures/claude-managed-tools-probe.mjs
```

Exit 0; `managedToolAdvertised: true`, `nativeAgentAdvertised: false`. Native CLI tool visibility is stronger evidence than a stub assertion, but it does not prove account authentication, quota availability or production confinement.

Follow-up covering verification: **465 tests passed**, exit 0, no skips. It adds the autonomous loop/guard tests, Claude process/runtime compatibility, Codex dynamic tool requests, existing host identity/capacity/cancellation/replay, MCP forwarding, and existing delivery floors and repair gates. After the cancellation race fix, **70 lifecycle tests passed**, exit 0. The final cleanup reruns the affected autonomous/lifecycle tests. Syntax checks and `git diff --check` pass.

Both provider preflights were checked again and still report the unavailable systemd user bus. No live provider call passed that required gate. The earlier native Codex sandbox canary blocker remains unverified in this restricted host.

Exact follow-up covering command (exit 0, 465 passed):

```sh
DEN_AUTONOMOUS_TRACE=/tmp/den-autonomous timeout 300 node --test --test-concurrency=2 apps/bridge/agents/autonomous-delegation.test.mjs apps/bridge/agents/host-managed-tools.test.mjs apps/bridge/agents/host-orchestration.test.mjs apps/bridge/agents/orchestration.test.mjs apps/bridge/agents/claude-adapter.test.mjs apps/bridge/agents/claude-runtime-host.test.mjs apps/bridge/agents/claude-process.test.mjs apps/bridge/agents/codex-adapter.test.mjs apps/bridge/agents/codex-runtime.test.mjs apps/bridge/agents/host-runtime-identity.test.mjs apps/bridge/agents/host-runtime-contract.test.mjs apps/bridge/agents/host-capacity.test.mjs apps/bridge/agents/host-cancel-handover.test.mjs apps/bridge/agents/host-sessions.test.mjs apps/bridge/agents/host-den-tools.test.mjs apps/bridge/library/servers/den.test.mjs apps/bridge/delivery/plan.test.mjs apps/bridge/delivery/floor.test.mjs
```

Final affected checks after cleanup (exit 0, 10 passed):

```sh
timeout 300 node --test --test-concurrency=2 apps/bridge/agents/autonomous-delegation.test.mjs apps/bridge/agents/host-managed-tools.test.mjs apps/bridge/agents/claude-runtime-host.test.mjs
```

All 20 changed/new JavaScript files passed `node --check`; `git diff --check` exited 0. The native Claude local-API probe exited 0. No work remains in this implementation slice; live provider verification on a supported host is the remaining environment gate.

## Live verification completed

The earlier systemd and native sandbox blockers were resolved on 2026-10-24 Pacific using approved host-context execution. Both real provider smokes passed with their native sandbox and resource enforcement intact. Live probing also fixed a redundant first-message bootstrap turn, missing governed Codex mount targets, and ambiguous leaf instructions.

[Live report, actual traces, settings, source digest and unsuccessful attempts](evidence/live-tiered-2026-10-24/README.md). This supersedes the earlier environment-blocked status for the bounded lead/implementer smoke. It does not extend that proof to large trees or arbitrary live code-writing work.
