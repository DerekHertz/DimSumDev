# Disabled Codex permission translation

This stage adds a pure **Codex 0.163.0** named-profile translator and an explicitly invoked offline SHELL canary. It does not register a runtime, launch app-server, read an account, call a model, or complete ticket16. Every compiled result retains `launchable: false`.

The eventual input must come from one shared effective-role-policy authority. The translator currently accepts explicit versioned read roots, write roots, governed read-only paths, denied credential paths, forbidden command prefixes and an empty network-host set. It rejects unrepresented requirements. The shared effective-role-policy authority now supplies Claude compilation with byte-for-byte compatibility; connecting these clauses to a protected Codex runtime remains pending.

## Native representation

The field names and filesystem precedence were inspected in the installed Ubuntu Codex **0.163.0** app-server schema and the official `rust-v0.163.0` configuration/protocol source. Custom profiles without a parent begin restricted: unmatched paths deny. The translator emits `:minimal` read access and exact read/write/deny paths. More-specific entries win; a more-specific grant under a protected denial or read-only path is rejected. No broad root grant, glob snapshot or implicit temporary write is emitted.

Native named profiles request network disabled, approval policy never, empty shell-environment inheritance, and disabled native delegation/hooks/plugins/alternate surfaces using real versioned configuration keys. These are configuration requests, not launch-path proof. Forbidden execution prefixes preserve the input command rules but are not shell confinement; aliases and indirect execution still need protected enforcement. Private configuration, native-store protection, canonical/symlink validation, resource enforcement, scoped connection interposition and actual native tool conformance remain required.

Governed read-only paths are ceilings: they become native read entries only beneath an already admitted root and outside denied subtrees; otherwise they remain denied. They cannot introduce read access or reopen credential/store denials. Sparse or decorated policy lists are rejected instead of silently omitting restrictions.

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

The prepared correction requires the installed helper and grants only that executable read access, never its package/home parent directory. Before creating a fixture, listener or launcher, execution admission resolves **all three** supplied binary paths (Node, Codex CLI wrapper and native helper), requires regular files and checks execute access. Wrapper symlinks are resolved to the checked file; the exact resolved path is then used. Directories, directory aliases and non-executable files refuse admission. The pure plan validates representation only and claims no filesystem proof; separate disposable filesystem fixtures cover execution admission without running their dummy executables.

After code, QA and security review passed candidate `741bf56d95d5a70818b86d4fdd63b090d9b9f950`, exactly one corrected offline run was authorized. It also failed without probe results:

```text
resolved CLI: /home/dhertzell/.nvm/versions/node/v22.23.3/lib/node_modules/@openai/codex/bin/codex.js
argv: sandbox --permission-profile bridge-offline-canary --cd /tmp/den-codex-profile-task2-NSrB7z/worktree -- /home/dhertzell/.nvm/versions/node/v22.23.3/bin/node /tmp/den-codex-profile-task2-NSrB7z/worktree/probe.mjs /tmp/den-codex-profile-task2-NSrB7z 51309
cwd: /tmp/den-codex-profile-task2-NSrB7z/worktree
unit: den-run-codex-profile-0511c85018fbb048.scope
slice: den-agents-codex-task2
status: code 1, signal null
settled: true; outputDrained: true; overflow: false
localhost connections: 0; dummy markers preserved: true
probe results: null; native diagnostics: empty; verdict: FAIL
```

The bounded receipt was read and reported before a later WSL guard cleanup pruned this Windows worktree's Git metadata. Its original recorded SHA-256 was `D81B946309609CAE43A11C44B2604DACB70269A7D45B731B07AEF9EA68DA145B`; those original bytes are no longer available. The task handoff retains a clearly labelled reconstruction from the observed tool output, without claiming the original byte hash or audit integrity. The committed branch was preserved and its task-owned worktree was recovered and locked against cross-platform pruning.

The owned fixture was removed after confirmed group cleanup. The native failure stage/cause remains uncertain because the CLI emitted no diagnostic; this is not an 18-check pass or a claim that the kernel lacks the required features. No retry followed. Further native execution remains on first-failure hold pending diagnosis/review and explicit authorization. Default production registration and live model/account/auth calls remain disabled.

## Remaining integration gates

Ticket16 now has shared policy extraction and the Codex five-hour usage exemption; protected launch/store/configuration integration, scoped approved connections and lifecycle integration remain pending. Ticket72 requires actual adapter launch-path checks, including native tools, denied credential access, approved connections, cancellation and exact crash/graceful resume. Ticket02 requires independent protection review and the separate user-merge change before production registration. Unit fixtures and SHELL-only experiments do not satisfy those gates.
