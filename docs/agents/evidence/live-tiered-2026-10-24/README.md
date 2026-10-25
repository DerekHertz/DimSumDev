# Live tiered delegation — 2026-10-24 Pacific

## Final integrated candidate

Fresh account-backed smokes passed on commit `660240a`, rebased onto `bf72c1a` (PR #420). [Claude trace](integrated/claude.jsonl), [Claude result](integrated/claude-result.json), [Codex trace](integrated/codex.jsonl), [Codex result](integrated/codex-result.json). Each trace records the runtime-source digest. Each run launched exactly one lead and one implementer, with one delegation and a 90-second deadline. Both used the same model/reasoning/Standard settings listed below. Codex usage/cost remain unknown. Claude reported $0.0146736 for the lead and $0.00071389 for the child.

Integrated verification: 275 covering tests passed; 4 native sandbox canaries passed without skips; 24 JavaScript syntax checks passed. Independent Standards/security and Spec reviews passed for `660240a`. The adapter resume regression checks that unsupported dynamic-tool definitions are omitted from `thread/resume`; it does not exercise a live resumed delegation. Native resume/steer and Jiao desk identities from upstream are preserved.

Commands (approved host context with the existing user-bus environment):

```sh
node scripts/smoke-tiered-live.mjs claude /tmp/den-tiered-live-integrated
node scripts/smoke-tiered-live.mjs codex /tmp/den-tiered-live-integrated
```

## Earlier pre-integration evidence

The remaining report and root-level manifest/traces below describe the earlier working tree, before integration with PR #420. Their source digest is historical and does not identify the final integrated runtime.

Both account-backed smokes passed. Each successful run used one lead, one bounded implementer, one delegation, and a 90-second deadline. The child read a fresh six-digit marker from a disposable committed file; the lead returned that marker. No manager, code edit, commit, push, deployment or account setting change was requested of either model.

| Provider | Lead observed model | Lead reasoning | Child observed model | Child reasoning | Speed |
| --- | --- | --- | --- | --- | --- |
| Bao / Claude | `claude-sonnet-5-5` | medium | `claude-haiku-5-5` | low | Standard |
| Jiao / Codex | `gpt-6.1-sol` | medium | `gpt-6-luna` | medium | Standard |

Model IDs above came from live native model events/acknowledgements. Reasoning and speed are the effective invocation values, not an independently echoed Claude server setting. Claude receives `--effort` and invocation-local `fastMode: false`; Codex receives a private reasoning configuration and `serviceTierForTurn: "default"`. The exact flags/protocol mapping is covered by adapter tests. No most-expensive-model fallback was enabled.

- [Claude actual trace](claude.jsonl), [Claude result](claude-result.json).
- [Codex actual trace](codex.jsonl), [Codex result](codex-result.json).
- [Source and verification manifest](manifest.json).

Successful Claude run: lead `c-bda3167078a99a3b`, child `c-a8ce1da1f5d5c07a`. Successful Codex run: lead `c-907db366844834e2`, child `c-e3028256e03fd726`. All four systemd scopes were confirmed inactive after completion.

Claude's final smoke reported $0.0152432 in CLI cost accounting, with token/cache measurements in the result and trace. This is provider-reported accounting, not a claim about subscription billing. Codex token usage and cost were not captured by this adapter and remain **unknown**, not zero.

## Environment resolution and fixes

The systemd manager was healthy. The desktop command sandbox could see its socket but could not use the bus normally. An approved host-context command with `XDG_RUNTIME_DIR=/run/user/1000` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus` returned `running`. The existing launcher's bus discovery then passed both provider preflights in that host context. No service restart, new bus, remount, permission loosening or sandbox disable was needed.

The live harness runs from the CLI, but switching the whole chat to CLI was unnecessary. The desktop session launched that harness through approved host execution. The bridge controller could reach systemd; its agents still ran inside the production scope, resource limits, outer bubblewrap wrapper and native provider sandbox. A CLI agent using the same outer sandbox could need the same approval. See [OpenAI's sandbox documentation](https://learn.chatgpt.com/docs/sandboxing) for that distinction.

Live probing exposed three implementation gaps:

1. **Claude bootstrap:** the lead initially received a generic bootstrap turn before the user's first message. It delegated once before that message arrived, then tried a redundant second delegation. The process cap refused the third process. The desk now includes the first user request in its initial launch and records its normal message receipt. Existing native resume history retains its context without another redundant policy prefix.
2. **Codex writer setup:** `thread/start` failed while loading project instructions. A metadata-only probe isolated a native bubblewrap failure mounting `.github` because a protected CI path's parent did not exist. Governed mount targets are now prepared in the isolated worktree, without removing or changing any read-only policy. Cleanup removes only owned unchanged empty files/directories; existing content, replacement inodes and symlinks are protected. The same metadata-only setup then passed before another paid inference attempt.
3. **Leaf context:** Luna initially interpreted the generic delegation rule as requiring another delegate tool. The leaf brief now states that its task has already been delegated, it must perform the work directly with local tools, and no delegate tool is provided or needed. The final live Codex run read the marker successfully.

Native RPC errors now retain only the operation, numeric code and a small allowlisted category. Raw account/credential diagnostics remain withheld. No authentication or quota blocker was observed in the final successful smokes.

## Verification

- Both production runtime preflights: `ok: true`, in approved host context.
- Native sandbox canaries: **4 passed, 0 skipped**, exit 0. They verified sandbox startup, outside-write/credential denial, outbound-connection denial, and absent native child tools.
- Covering tests after the live fixes: **90 passed**, exit 0.
- Final focused cleanup/privacy checks: **35 passed**, exit 0.
- The writer-setup regression was observed red before integration, then green with its missing-CI-target assertion.
- `node --check` for changed JavaScript and `git diff --check`: passed.

Native canary command, run from the approved host context:

```sh
timeout 300 node --test --test-concurrency=2 apps/bridge/agents/codex-sandbox-start.test.mjs apps/bridge/agents/codex-sandbox-write.test.mjs apps/bridge/agents/codex-sandbox-network.test.mjs apps/bridge/agents/codex-no-children.test.mjs
```

Live commands:

```sh
node scripts/smoke-tiered-live.mjs claude /tmp/den-tiered-live-2026-10-24/final-candidate
node scripts/smoke-tiered-live.mjs codex /tmp/den-tiered-live-2026-10-24/after-leaf-brief
```

Each harness invocation uses the real runtimes and their default enforced launchers, real host authentication, and the existing bridge dispatch/admission/cancellation path. It uses a throwaway repository and short smoke-only trusted recipes to bound context. It does not use fake provider servers or an unconfined launcher. The native provider tools perform the actual file read. Earlier metadata-only diagnostics deliberately blocked `turn/start`; those diagnostics are not counted as live inference evidence.

## Provenance and unsuccessful attempts

Base commit: `706466b796e1bf1a61b92de8d67d80bbeda8defb`; branch: `codex/tiered-orchestration`; the captured code was an uncommitted working tree at that time. The manifest identifies the runtime files and their SHA-256 digest. Runtime sources did not change between the successful Codex run and the final Claude run, which recorded that digest. Tests, evidence and the harness's digest field were the only intervening edits.

Earlier attempts are retained separately rather than presented as passes:

- [Claude redundant-bootstrap failure](claude-initial-failed.jsonl).
- [Claude first pass before the final shared leaf wording](claude-first-pass.jsonl).
- [Codex initial child startup failure](codex-initial-thread-start-failed.jsonl).
- [Codex startup failure with safe RPC stage diagnostics](codex-thread-start-failed.jsonl).
- [Codex writer-startup pass followed by leaf-context refusal](codex-leaf-brief-failed.jsonl).

The initial Claude harness counter included a refused third spawn; it did not launch a third native process. Final counters count permitted native process invocations. Two processes do not mean exactly two inference requests: a native agent can make a model request before and after a tool result. No manager or full hierarchy was launched in these tiny live tests. Larger trees, arbitrary code-writing tasks, simultaneous provider leads and live manager integration remain outside this smoke's evidence. The existing mocked three-process tests cover manager/child integration separately.
