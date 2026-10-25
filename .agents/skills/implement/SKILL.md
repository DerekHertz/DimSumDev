---
name: implement
description: "Implement a piece of work based on a spec or set of tickets. Use when a ready-for-agent ticket is assigned to you."
---

Before working, read `.codex/runtime-guidance.md` for the Codex execution contract. Shared safety and approval gates, explicit ticket limits and stricter session constraints still apply.

Implement the work described in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Claim the ticket first, following the `team-protocol` skill. Stop and hand off if the ticket is already claimed or blocked.

Before editing, state the observable outcome, acceptance criteria, scope exclusions, and covering checks. Reuse an already-approved scope and test seams. Keep this brief in the ticket or handoff rather than creating another planning artifact.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run required typechecking and literal covering test files, including affected existing callers, within the runtime's time and concurrency bounds. Full suites and browser workloads belong to designated checks/CI unless separately authorized. Keep one verification record: candidate or working diff, command, result, and relevant environment. Reuse a result while those inputs remain unchanged; rerun an affected check after a relevant edit, changed environment, or new failure evidence, or when a required independent gate calls for it. A status update, handoff, or reviewer return alone is not a reason to repeat passing checks.

Fix an unmet criterion or material safety, correctness, or truthful-presentation risk in this outcome. Record unrelated defects and nonblocking polish as follow-ups. If the same failure survives a targeted fix, or a correction reveals a different failure class, pause edits and consolidate the evidence, cause, smallest useful remaining scope, and next discriminating check into one recovery plan. Continue only within the approved scope and attempt limits; a twice-failed ticket follows team-protocol's human gate.

Once done, call the Skill tool with "code-review" to review the work.

Address review findings together, identifying which block the criteria or a material risk. Allow at most one fix round for nonblocking findings; leave remaining polish as follow-ups. Stop implementation when the criteria and required gates pass.

Commit your work to the current branch (your agent's worktree branch). Never merge to main: merging is a pass gate.

Finish with /handoff.

<!-- Adapted from mattpocock/skills engineering/implement (MIT). See .claude/skills/VENDORED.md. -->
