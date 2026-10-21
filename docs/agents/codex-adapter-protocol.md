# Disabled Codex protocol prerequisite

`apps/bridge/agents/codex-adapter.mjs` implements the bounded app-server transport portion of codex-residents/16. It is not a CellRuntime, starts no process, reads no account or configuration, and is not registered by production startup. `CODEX_PRODUCTION_ENABLED` stays false. This change does not complete ticket16 or enable Codex task trees.

The protocol was checked against JSON schema generated offline by Ubuntu Codex CLI **0.163.0**, using `codex app-server generate-json-schema --experimental --out <private worktree metadata directory>`. Native launch-path conformance remains unproved.

## What the module does

- Correlates client responses separately from server requests, including when both directions use the same ID. Unsolicited, duplicate, ambiguous, malformed or oversized messages close the transport and settle pending calls.
- Completes `initialize` before sending `initialized`. Discovers available models through bounded `model/list` pagination and requires the exact configured model and effort; there is no model fallback.
- Checks the native thread, model, working directory and named permission-profile acknowledgement before a turn. Resume requires the exact recorded native thread ID. The acknowledgement is protocol evidence, not proof that the profile confines tools.
- Translates bounded text, tool and completion events. Early turn events wait for the correlated turn acknowledgement. Foreign thread/turn events and observed native child delegation close the transport.
- Rejects all native command/file approval requests and unsupported requests. This includes session grants, policy amendments, permission overlays, `grantRoot`, authentication refresh and arbitrary dynamic tools. There is no generic bridge Allow conversion.
- Routes bounded non-secret questions to the host and accepts answers only once, for their exact question IDs and active turn. Turn completion, interruption, expiry and transport closure invalidate questions.
- Queues messages with cancellation before native delivery. A `turn/steer` receipt must name the exact active turn. Transport timeout means an uncertain outcome; it creates no automatic retry.

## Protected integration required

`createCodexProtocol` takes a transport writer/closer. Its optional `authorizeExecution` callback is reserved for trusted compiler/launcher integration. Without it, thread preparation and model turns refuse to run. No environment flag enables execution.

The callback receives a thread/turn context and must perform the actual protected admission before returning a compiled `profileId`, `cwd` and, for thread creation, trusted configuration/instructions. The transport accepts named custom profiles rather than the unrestricted built-ins, preserves their identity through turns, and refuses profile changes without fresh admission. A callback returning values is not itself confinement proof: protocol fixtures deliberately inject a fake authorizer and prove no OS security property.

The Linux schema exposes named `permissions` on thread and turn requests and `activePermissionProfile.id` on thread responses. These fields are mutually exclusive with the older sandbox settings. Its coarse `SandboxPolicy` does not represent the credential-deny/read-root rules required here. The follow-up compiler must produce the actual restricted profile, suppress inherited configuration/native children, and verify the acknowledged profile. `multiAgentMode` is deprecated and ignored in the inspected schema; it is not enforcement.

The remaining runtime work must use the existing enforced resource launcher, a protected persistent native store, trusted role recipes, catalog-approved connections and per-run capabilities. Its closer must kill/reap the run's resource group, revoke credentials and settle uncertain operations. This transport supplies none of those mechanisms and must not be wired into production in their absence.

## Remaining gates

1. Complete ticket16's shared permission compiler, protected process/store integration, connection interposition and protocol features not provided here, including usage translation and runtime lifecycle integration.
2. Run ticket72's actual adapter launch-path checks for filesystem/native tools, credential denial, network, approved connections, resources, cancellation and exact graceful/crash resume.
3. Complete independent ticket02 review and the separate user-merge change before production registration.

Normal Claude behavior and Codex-unavailable responses remain controlling. No fixture result replaces real conformance, authorizes a scope increase, raises simultaneous capacity, or grants publication authority.
