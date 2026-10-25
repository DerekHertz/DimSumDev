# Optional security-audit workflow

Cloudflare's `security-audit` skill is available on request. It adds source-based trust-boundary analysis, coverage tracking and independent finding validation. Routine security review and the existing delivery gates continue to apply; the skill is not preloaded into a role or required for every change.

For a focused review, ask:

> Use security-audit in guidance mode to review the Codex thread-resume boundary. Report the reviewed commit, source evidence, confirmed findings and validation gaps.

For an audit with retained reports, ask:

> Run a quick, scoped security-audit of apps/bridge/agents at this commit. Agree the scope, budget and writable external output path before execution.

Guidance mode loads only the relevant references and does not create audit artifacts automatically. Full audit mode runs the upstream phases, coverage ledger and report validators. A quick or scoped audit reports partial coverage. Neither mode authorizes changing source or probing live services.

Before executing target-controlled code, verify every control in the skill: network isolation, an allowlisted environment, read-only target/toolchain, scratch-only writes and explicit resource limits. The ordinary agent sandbox and the den's local CI checks are not evidence that every audit control is satisfied. If any required control is unavailable, continue source inspection and report the exact needs-validation blocker. Full audits also require the upstream write-isolation and safe artifact-promotion procedure.

The source is `.claude/skills/security-audit/`; `scripts/codex-sync.mjs` generates the Codex mirror under `.agents/skills/security-audit/`. Edit the source and stage new files before syncing, because the generator copies tracked files. Skills become discoverable in a fresh session using the checkout that contains them; updating the installed den still follows the normal release process.

Upstream: [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit), pinned at `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`. The [MIT license](../../.claude/skills/security-audit/LICENSE) is retained. Adaptations are recorded in [VENDORED.md](../../.claude/skills/VENDORED.md).
