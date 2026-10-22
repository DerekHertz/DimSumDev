# Codex runs on its own sandbox inside the resource group, not behind a second wall

**Status:** Proposed (den-revival/01). The user accepts it by merging the PR that builds it.

**Context.** Codex cannot start under the den: three diagnostic launches (PR 389) each exited 1 in about 0.5 s with no output. The working theory was that Codex's bubblewrap cannot nest inside the den's. A probe on this host (Codex 0.163.0, no model or account call) does not support it:

- `codex sandbox -- /bin/echo ok` passes on the host, inside the resource group's exact wrapper flags (`--dev-bind / / --unshare-pid --proc /proc --ro-bind /sys/fs/cgroup ...`), and inside `systemd-run --user --scope` + `prlimit` + `setpriv --no-new-privs` + the bus-directory tmpfs + `env -i`. Nesting works.
- With a named permission profile (what PR 389 uses) and **no den at all**, the failure reproduces on the host: `bwrap: execvp .../codex-linux-x64/.../bin/codex: No such file or directory`. Codex re-executes its own helper inside the sandbox, so the profile must grant read on that exact file. With the helper granted (and the Node binary, for a Node command), the same profile passes on the host and nested.
- So the first failure was a profile that omitted the helper, not nesting. The later empty-output failures are unexplained: PR 389 had granted the helper by then, and its stderr was never captured intact. Cause unknown.

What each layer is today. The resource group's outer bwrap is not a filesystem or network wall. It keeps a run from loosening its own limits (cgroup read-only, bus sockets and journal hidden, private pid namespace). The Claude path's filesystem and network wall is Claude's own sandbox (ADR 0021 amendment 1), nested inside that wrapper, covering shell commands only. The bridge has no den-owned confining bwrap for agents; the only confining one is the build box (`apps/bridge/build/box.mjs`), which has no network.

## Options

**1. Outer wall only, Codex sandbox off (`danger-full-access`, approvals never).** Filesystem, credential and network limits must all come from a new confining bwrap. It must let the Codex process reach OpenAI while keeping the model's shell commands off the network, in one process tree with one network namespace: that needs a host-allowlist egress proxy, which the den does not have. The model's shell and file edits are then confined by nothing but code we have yet to write. PR 389's profile compiler and canary become dead code. New unproven enforcement on a risk path.

**2. Codex's own sandbox on (the named profile), network off for tools; resource group kept.** Enforcement is native and per command; the Codex process itself keeps its OpenAI connection. This is the Claude path's shape (native sandbox for the model's commands, scope for resources), and PR 389's compiler, launcher, runtime and tests survive.

| | Option 1 | Option 2 |
|---|---|---|
| Writes outside worktree | new wrapper must enforce | Codex sandbox (probed: not persisted) |
| `~/.codex` auth, other credentials | new wrapper must hide | profile grants no read (probed: invisible); PR 389 mounts the auth file read-only into a private store |
| Network | needs an allowlist proxy to reach OpenAI | tools off (probed: DNS fails); Codex process reaches OpenAI |
| Processes, memory, CPU | resource group | resource group |
| Parity with Claude | no | yes |
| Testable without a model | only after new code exists | yes, `codex sandbox` needs no account |
| PR 389 kept | launcher, runtime shell | nearly all; fix the profile |

## Decision

**Option 2.** Codex's native sandbox is the only filesystem and network layer for the model's commands. The resource group stays for limits. The outer bwrap stays too, because it is the resource group's own guard and it nests fine; Codex runs without it only if test 1 below shows it truly cannot start there (the scope, `prlimit` and start gate stay either way). `danger-full-access` is never used.

Costs accepted. The Codex process, like the Claude CLI, is outside its own sandbox: only shell commands and patches are confined, and native hooks, plugins and MCP stay disabled (PR 389 does this). A write the sandbox refuses can exit 0 into a private mount, so tests check the host disk, never the exit code.

## Tests ticket 01's developer writes (none calls a model)

1. **Starts under the real wrapper.** Build the real launch plan (scope, `prlimit`, outer wrapper, profile granting the Node binary and the pinned helper on top of the platform default read set, `:minimal`) and run `codex sandbox ... -- node probe.mjs` with stderr kept. Assert exit 0 and the probe's output. It fails today; its stderr is the missing evidence. It skips, with a named reason, when `codex`, `bwrap` or the user bus is absent.
2. **Write outside the worktree is refused.** Same launch; the probe writes one file in the worktree and one at a host path outside it (not under `/tmp`). Assert from the host that the first exists and the second does not, and that a planted fake `auth.json` is neither readable nor changed.
3. **Outbound network is refused.** Same launch; the probe connects to an owned localhost listener. Assert the listener saw zero connections and the probe reports a refusal, not a timeout.

One direct task through the runtime against a stub app-server is ticket 02's, not this one's.

## Consequences

- If test 1 still fails under the real wrapper after the profile is right, bisect with the same probe (drop the tmpfs hides, then `--unshare-pid`, then the scope) before revisiting this decision.
- Changing the wall is a user gate: the PR is left for the user to merge.
