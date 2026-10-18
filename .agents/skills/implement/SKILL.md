---
name: implement
description: "Implement a piece of work based on a spec or set of tickets. Use when a ready-for-agent ticket is assigned to you."
---

Implement the work described in the spec or tickets.

Claim the ticket first, following the `organism-protocol` skill. Stop and hand off if the ticket is already claimed or blocked.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end. Delegate long test or log output to the `scout` subagent so only a summary comes back.

Once done, use /code-review to review the work.

Commit your work to the current branch (your cell's worktree branch). Never merge to main: merging is a pass gate.

Finish with /handoff.

<!-- Adapted from mattpocock/skills engineering/implement (MIT). See .claude/skills/VENDORED.md. -->
