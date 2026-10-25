# Hand CI waiting to the existing monitor

When a pushed candidate is waiting only for hosted checks, record the PR URL, expected head SHA, completed local checks and next owner's action in the handoff, then end the agent run. Status monitoring belongs to the bridge, without a model repeatedly deciding to check again.

- **Active delivery:** its [runner](../../apps/bridge/delivery/runner.mjs) owns CI waiting through the [git-host adapter](../../apps/bridge/delivery/git-host.mjs). Leave that delivery in charge.
- **Other open PR in the bridge's configured repository:** the existing [CI watcher](../../apps/bridge/delivery/ci-watch.mjs) discovers it automatically. There is no per-PR registration step. It stays quiet while checks are pending or green, retries a first timeout once, and wakes Bao once per commit for a real failure. Repeated failure is shown as requiring the user. A delivery-owned PR is excluded from this watcher to avoid duplicate handling. A PR in another repository is not automatically covered by this watcher.

Agents resume for an actionable failure, a user request or another required decision. Do not repeatedly invoke `gh pr checks`, `gh run view`, tool-session polls or log-tail commands to wait for a status change, or start another monitoring agent or automation. A fresh status read at an actual completion or merge decision is appropriate: verify the expected head and every required check. Silence from a failure watcher is not proof of green, and monitoring grants no merge authority.

The production [bridge entry point](../../apps/bridge/server.mjs) enables the watcher. This is a runtime capability, not proof that the installed service is currently healthy. If the watcher is unavailable or cannot be verified, report that limitation rather than claim a handoff succeeded. When explicitly asked to wait in a session without a usable bridge watcher, use one tool-owned watcher with an explicit timeout and only a terminal summary; end on completion, failure or timeout. Do not wrap it in model-driven status loops.

Repository edits take effect in sessions using that checkout. The installed den uses release folders: merge and update through the normal release process before relying on new instructions in resident runs.
