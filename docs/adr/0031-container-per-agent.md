# A container per agent under rootless Docker

**Status:** proposed. A spike (hardening/05) ran on 2026-10-22; the user accepts or rejects it. It builds on ADR 0021 decision 2, which named a container per agent as the wall's fallback, and on the hardening spec's Containers section (C1-C3). The harness and its evidence are in `spikes/container-agent/` (throwaway).

**Context.** The CLI sandbox walls shell commands only. The agent process, with its file tools, hooks and MCP, runs outside it, and every hole so far (the file tools, the `.git` refs) was a complete-mediation failure patched one rule at a time. A container puts the whole agent inside the boundary: a path the bridge did not mount is not refused, it is absent.

## Decision

**Go.** Start each agent in its own rootless Docker container. The bridge integration and the credential proxy are follow-up tickets; nothing in the bridge changes here.

1. **Runtime: rootless Docker in WSL, from Docker's apt repo** (`docker-ce`, `docker-ce-rootless-extras`, `uidmap`), daemon as a systemd user service. Not Docker Desktop, not rootful. The bridge talks to `unix:///run/user/1000/docker.sock` with `/usr/bin/docker`, because the `docker` first on `PATH` is Docker Desktop's Windows binary. Install, once:
   ```
   sudo bash spikes/container-agent/install-rootless.sh   # packages + repo, disables the rootful daemon
   /usr/bin/dockerd-rootless-setuptool.sh install         # as the user
   ```
2. **The container.** One per agent, `--rm`, from a pinned image (`node:22-bookworm-slim`, git, the CLI at the den's pinned version). It runs as container root (`--user 0:0`), which rootless Docker maps to the user's own uid, so the bind mounts stay writable with no chown and the user stays unprivileged on the host. It also runs with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` root, and tmpfs `/tmp` and `/root`. Limits come from the role's class in `limits.json` as `--memory`, `--memory-swap` (the same value, so no swap), `--cpus` (`cpuPercent / 100`) and `--pids-limit`.
3. **Mounts, each at its host path** (paths in the stream and the handoff stay true on the host):
   - the worktree, read-write;
   - the main checkout's `.git`, read-only, with read-write mounts over only what a commit on the agent's branch writes: `.git/worktrees/<name>`, `.git/objects`, `.git/logs`, and `.git/refs/heads/<branch namespace>`.
   Nothing else. `.git/config`, hooks, other branches' refs and other worktrees' metadata stay read-only, and that closes the `.git` refs hole by construction. Ticket files and grants would be added as further read-only (or, for a grant, read-write) mounts.
4. **Network: an internal Docker network plus one allowlist proxy.** Agents join `den-agents` (`--internal`: no route out, no DNS). One proxy container sits on that network and the default bridge. It tunnels `CONNECT` only to the hosts on the role's list, and it fronts the Anthropic API (decision 5). Agents get `HTTPS_PROXY` and `ANTHROPIC_BASE_URL` pointing at it. A per-role list means one proxy instance (or one port) per list; the spike ran one list.
5. **The login lives in the proxy, never in the agent.** The agent gets `ANTHROPIC_BASE_URL=http://den-proxy:8080` and a dummy `ANTHROPIC_API_KEY`. The proxy drops the dummy key, adds `Authorization: Bearer <OAuth access token>` and the `oauth-2025-04-20` beta header, and forwards to `https://api.anthropic.com`. The agent can spend the login through the proxy, which is unavoidable, but it cannot read or copy it. The spike passed the token as a proxy env var. The follow-up must handle refresh (the access token expires; the refresh token stays with the bridge) and keep the token out of `docker inspect` (a file mount into the proxy only).
6. **gVisor and microVMs: not now.** The rootless container met every question. `runsc` adds a second kernel boundary but its rootless mode is limited, and a microVM (Firecracker, Kata) needs KVM in WSL. Revisit only if the threat model grows to a hostile model escaping a namespace.

## The seven wall questions (evidence: `spikes/container-agent/evidence/`)

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | The CLI starts with the bridge's spawn flags (`-p`, stream-json both ways, `--permission-prompt-tool stdio`)? | **Yes.** `system/init` in about 0.9 s after spawn, `permissionMode: default`; `can_use_tool` requests reached the harness over stdio and its `control_response` allow/deny took effect. | `run2/results.json` `init`, `turns.*.permission` |
| 2 | A write outside the mounted worktree is impossible, for Bash and for Write/Edit? | **Yes.** Bash to an unmounted path: `No such file or directory`. Bash to a read-only mount: `Read-only file system`. Write to `$HOME`: `EROFS ... mkdir '/home/dhertzell'`. Edit on a read-only mount: `EROFS`. The harness's own writes to the main `.git/config` and `refs/heads/main` failed `Read-only file system`. Nothing appeared on the host disk. | `run2`, `run3` `turns`, `disk`, `inspect` |
| 3 | The network is blocked except for named hosts? How? | **Yes, by Docker network plus proxy.** Direct: no DNS, and a raw IP gets `Couldn't connect`. Through the proxy: `example.com` 200, `example.org` CONNECT 403, `api.anthropic.com` CONNECT 403 (the API is reachable only through the token-injecting front). It holds against root in the container: the internal network has no gateway, and `NET_ADMIN` is dropped. | `q3-network.txt`, `proxy.log`, `run2` `net-*` |
| 4 | Commands inside run with no prompt? | **Yes.** Bash calls allowed by settings ran with no `can_use_tool` request. Write/Edit, not on the allow list, produced one request each, as on the host. | `run2` `turns.bash-*` (empty `permission`) |
| 5 | CPU and memory caps from `limits.json` apply to the container and its children on WSL cgroup v2? | **Yes, under Docker (Podman not needed).** The user slice delegates `cpu memory pids`. Inside: `memory.max 2147483648`, `cpu.max 100000 100000`, `pids.max 256`. A child allocating 3 GiB was OOM-killed (exit 137, `oom_kill 1`). Four busy children for 5 s used 5.14 s CPU, so one CPU, throttled. 151 of 400 spawns failed at the pids cap. | `q5-limits.txt` |
| 6 | Read, Write, Edit on an unmounted host path? | **Absent, or read-only.** Read: `File does not exist` (including `~/.claude/.credentials.json`). Write/Edit: `EROFS` from the read-only root. One catch: a path under the container's tmpfs (`/tmp`, `/root`) is written there and vanishes with the container. It never reaches the host, but the tool reports success. | `run2`, `run3`, `run1` `write-outside` |
| 7 | A refusal can be told from an ordinary failed command in the stream? | **Partly.** A host permission deny: yes, the harness sent it, and the `tool_result` carries the host's message verbatim. A read-only mount: yes, `EROFS` / `Read-only file system`. The network: yes, CONNECT 403, and the proxy logs it. An unmounted path: **no**, it reads as an ordinary missing file, which is the point of "absent". The bridge can tag refusals it caused (deny messages, proxy log), not ones the mount table causes. | `run2` `write-denied`, `bash-fail`, `bash-outside` |

## Measurements

- **Cold start.** Container start adds about **0.75 s** per spawn (`docker run ... true` 730-815 ms, against `claude --version` at 11-17 ms on the host). `system/init` came 0.87 s after spawn in the container and 0.97 s on the host, with the first result at 3.5-4.3 s. Building the image takes 75 s, once (834 MB). (`cold-start.txt`, `run2`, `run3`, `host-baseline`)
- **Tokens.** The container adds none: the same argv and probe role cost **7.4k** input tokens on the first turn in the container and **8.3k** on the host. The container is about 1k cheaper because its fresh `HOME` loads no user-level CLAUDE.md or memory. Today's 23-26k cold spawn is the den roles' prompt (role, skills, project guide). It would carry over unchanged, minus the user-level files.
- **The worktree's `.git`.** Mounted as in decision 3, at host paths, `git add` and `git commit` inside worked, and the commit shows on the host branch (`den/probe`). The `gitdir:` pointer in the worktree's `.git` file resolves because the paths are identical.

## Consequences

- The wall stops being a list of rules to patch. File tools, hooks, MCP servers and Bash all sit inside one boundary that the bridge builds from mounts.
- The CLI's own sandbox settings and the per-path Read/Edit denies become defence in depth, not the boundary.
- One process per agent becomes one container. The bridge needs the image (pinned, rebuilt on a CLI bump), the network and the proxy as part of the service (ADR 0026).
- The den becomes portable to any Linux with rootless Docker. The whole-den container (C1 step 2) is a separate step.
- The model's auto mode is the CLI's default here. The bridge must keep pinning the permission mode, as the spike's settings did (`defaultMode: default`), or host permission requests stop arriving.

## Follow-up tickets (proposed)

1. **Bridge: spawn agents in containers.** Build the `docker run` argv from the ceiling (mounts from worktree, grants and ticket; limits from `limits.json`), behind a flag, with the wall conformance suite run against it. Risk path.
2. **The credential proxy as a den service.** Token from a file mount, refresh handled by the bridge, a per-role host list, and a log the den shows as refusals.
3. **The agent image.** A pinned Dockerfile in the repo, rebuilt by `den:update` when the CLI version changes, and checked by `risk-check`.
4. **Conformance: a Container spike in `conformance.mjs`.** Port this harness's probes so a CLI or Docker upgrade re-proves the seven answers.
5. **The whole den in one container** (C1 step 2), after 1-3 land.
