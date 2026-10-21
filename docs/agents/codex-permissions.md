# Disabled Codex permission translation

This stage adds a pure **Codex 0.163.0** named-profile translator and an explicitly invoked offline SHELL canary. It does not register a runtime, launch app-server, read an account, call a model, or complete ticket16. Every compiled result retains `launchable: false`.

The eventual input must come from one shared effective-role-policy authority. The translator currently accepts explicit versioned read roots, write roots, governed read-only paths, denied credential paths, forbidden command prefixes and an empty network-host set. It rejects unrepresented requirements. It is not a second role-policy authority and is not yet connected to Claude's compiler.

## Native representation

The field names and filesystem precedence were inspected in the installed Ubuntu Codex **0.163.0** app-server schema and the official `rust-v0.163.0` configuration/protocol source. Custom profiles without a parent begin restricted: unmatched paths deny. The translator emits `:minimal` read access and exact read/write/deny paths. More-specific entries win; a more-specific grant under a protected denial or read-only path is rejected. No broad root grant, glob snapshot or implicit temporary write is emitted.

Native named profiles request network disabled, approval policy never, empty shell-environment inheritance, and disabled native delegation/hooks/plugins/alternate surfaces using real versioned configuration keys. These are configuration requests, not launch-path proof. Forbidden execution prefixes preserve the input command rules but are not shell confinement; aliases and indirect execution still need protected enforcement. Private configuration, native-store protection, canonical/symlink validation, resource enforcement, scoped connection interposition and actual native tool conformance remain required.

## Offline canary and first failure

`apps/bridge/agents/codex-permissions-canary.mjs` launches nothing when imported. Its explicit `--run-offline` action creates only disposable dummy files and a fresh private Codex home. It uses ephemeral native auth storage, a whitelist child environment, an owned localhost listener, and only the **den-agents-codex-task2** resource slice. It never copies existing credentials. Thirty-second execution and 64KB output bounds apply. Cleanup kills the exact returned resource group and requires `settled(3000)` before deleting the canonical random fixture root. Uncertain cleanup preserves the fixture.

The intended 18 probe results cover source reads, scoped writes, credential/store denial, source/governance read-only restrictions, outside writes, symlink/proc aliases, descendant inheritance and blocked localhost networking. A network timeout alone is an unproved failure. Passing this canary would prove only this offline native SHELL path, not app-server tools or a production runtime.

The first authorized run on 2026-10-21 failed before the probe ran:

```text
CLI: /home/dhertzell/.nvm/versions/node/v22.23.3/bin/codex
argv: sandbox --permission-profile bridge-offline-canary --cd <random-fixture>/worktree -- /home/dhertzell/.nvm/versions/node/v22.23.3/bin/node <random-fixture>/worktree/probe.mjs <random-fixture> <owned-localhost-port>
unit: den-run-codex-profile-2dd65c0b521df2ae.scope
slice: den-agents-codex-task2
status: code 1, signal null
settled: true; outputDrained: true; overflow: false
localhost connections: 0; dummy markers preserved: true
probe results: null; verdict: FAIL (no conformance claim)
diagnostic: bwrap: execvp /home/dhertzell/.nvm/versions/node/v22.23.3/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex: No such file or directory
```

The original receipt did not capture the random fixture basename/port; its owned fixture was removed after settled cleanup. Later receipts include the exact executable, argv and working directory. Read-only inspection confirmed that the reported native helper exists, is executable and is canonical on the host; the installed public loader resolves that exact platform-package helper. The initial restricted profile admitted the probe's Node binary but omitted the sandbox's native re-exec helper.

The prepared correction requires the caller to supply that exact canonical installed helper and grants only that executable read access, never its package/home parent directory. Its fixture checks require the helper entry and reject missing/traversing paths. This correction has **not been rerun**; first-failure hold applies until the revised frozen source/plan is reviewed and a new run is explicitly authorized. Default production registration and live model/account/auth calls remain disabled.

## Remaining integration gates

Ticket16 still requires shared policy extraction, protected launch/store/configuration integration, scoped approved connections, usage and lifecycle integration. Ticket72 requires actual adapter launch-path checks, including native tools, denied credential access, approved connections, cancellation and exact crash/graceful resume. Ticket02 requires independent protection review and the separate user-merge change before production registration. Unit fixtures and SHELL-only experiments do not satisfy those gates.
