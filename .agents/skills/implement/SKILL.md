---
name: implement
description: "Implement a piece of work based on a spec or set of tickets. Use when a ready-for-agent ticket is assigned to you."
---

Before working, read `.codex/runtime-guidance.md` for the Codex execution contract. Shared safety and approval gates, explicit ticket limits and stricter session constraints still apply.

Implement the work described in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Claim the ticket first, following the `team-protocol` skill. Stop and hand off if the ticket is already claimed or blocked.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run required typechecking and literal covering test files with bounded concurrency and timeouts, including affected existing callers. In resource-limited den agents, leave full suites and browser workloads to designated checks/CI or a separately authorized capable environment. Delegate only independent checkable work when permitted; report exact evidence and remaining checks.

Once done, call the Skill tool with "code-review" to review the work.

Commit your work to the current branch (your agent's worktree branch). Never merge to main: merging is a pass gate.

Finish with /handoff.

<!-- Adapted from mattpocock/skills engineering/implement (MIT). See .claude/skills/VENDORED.md. -->
