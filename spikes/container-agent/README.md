# Container-per-agent spike (hardening/05, throwaway)

Evidence for ADR 0030. Not bridge code; delete once the bridge integration lands.

- `install-rootless.sh`: the sudo half of the rootless Docker install.
- `Dockerfile`, `proxy.mjs`: the agent image and the allowlist + credential proxy.
- `run.mjs`: starts one agent in a container with the bridge's flags and drives the probe turns (`ONLY=` subset, `HOST=1` baseline).
- `evidence/`: `run1` (no `-p`, auto mode: superseded), `run2` (main run), `run3` (Write to `$HOME`), `host-baseline`, `q3-network.txt`, `q5-limits.txt`, `cold-start.txt`, `proxy.log`.
