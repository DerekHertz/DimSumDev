---
name: usage-watch
description: Check plan usage and wind work down before the limit hits. Use at every dispatch decision, when a cell returns, and every 30 minutes or so in a long session. If the 5-hour window is at or above 90%, start wrapping up.
---

Select the provider from the active session, never from installed CLIs, credential files, or the chosen model. Use `node scripts/usage.mjs --provider codex` in Codex and `node scripts/usage.mjs --provider claude` in Claude. A legacy invocation without `--provider` still selects Claude; it must not be used to read Codex usage.

For Claude, `mcp__ccd_session_mgmt__get_usage` (main session only; the `5-hour limit` window's `percentUsed`) is also supported when available. The Claude CLI adapter reads the OAuth token from `~/.claude/.credentials.json` (WSL, Linux) or, on macOS, from the Keychain item `Claude Code-credentials`; native Windows is not supported and exits 1. It keeps the cloud estimate behavior. A weighted-token estimate is a trend estimate, never a live account quota reading.

The Codex adapter uses the supported app-server `account/rateLimits/read` exchange. It selects Codex account limits, maps 300-minute and 10080-minute windows to `5-hour` and `weekly`, and converts reset times to ISO. It does not read Claude credentials or substitute Claude estimates. Both providers retain the canonical `{"5-hour":{"percent","resets_at"},"weekly":{...}}` window fields. Each window also carries `resets_local`: the same instant in the system time zone with its abbreviation (for example `2026-10-06 00:00 PDT`), or `null` when the reset time is unknown. `resets_at` stays the canonical UTC value for machine readers. Missing or invalid Codex limits and CLI, auth, network, or timeout failures exit nonzero with a sanitized diagnostic.

Attribute every reading to its provider and source: live account, user-reported, or estimate. If live usage is unavailable, say so and ask the user for the active provider's usage report. Log unavailable windows and reset times as unknown; never invent them. If the user reports a percentage remaining, convert it to percent used (`100 - remaining`). Subagents ask the orchestrator for usage instead of reading a different account.

In a Claude cloud session (`CLAUDE_CODE_REMOTE` set), the legacy adapter cannot read live account numbers. Ask for the user's Claude usage report and log its 5-hour and weekly percentages with source attribution. In Codex cloud sessions, try the Codex adapter; if the supported invocation is unavailable, report the actual limitation and use a clearly attributed manual reading. Ask for fresh manual usage at dispatch or merge decisions when live readings are unavailable. Between decisions, estimates show trends only.

The recorded **Pro** plan assumption applies to Claude only. If Claude reports a different plan, flag the discrepancy. Do not carry Claude's plan name or limits into Codex; use Codex's reported account limits and treat an unavailable plan as unknown.

| 5-hour usage | Action |
|---|---|
| under 90% | Carry on. Check again at the next dispatch or cell return. |
| 90–94% | **Wrap up.** Start no new cells. Let a running cell finish or reach a clean stopping point, then stop. Record the agreed next steps in each open ticket's `## Comments`, write handoffs, stop any dev servers you started, and commit and push finished work (pushing is still a pass gate). Tell the user the percentage and when it resets, quoting `resets_local` (their own time zone), not the UTC `resets_at`. |
| 95% or more | **Stop now.** Nothing new at all. Write a one-paragraph handoff with what is in flight and where, and end. |

Also check the weekly window. At 80% or more, tell the user before dispatching anything expensive (Opus cells, the full relay).
