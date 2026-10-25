---
name: correct
description: "Make a repeated agent mistake impossible: fix it in architecture, types, a lint or a test, docs last. Use for /correct or a repeated friction row."
---

# Correct

The user keeps correcting agents in this repo for the same mistakes. Change the repo so the next agent can't make them.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Design the repo so a change that looks right from one file is right for the whole repo.

## Find the mistake classes

Start with the correction or friction evidence provided. Inspect related commits, reverts, review comments, and applicable instructions only as needed to identify the repeated cause. A class counts once it has happened twice. For a bounded task, select the class that affects its outcome; propose other classes as follow-ups rather than starting a repository-wide repair.

## Fix each class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source of truth. Delete old ways and dead code an agent would copy.
2. **Enforce it with types so the bad state can't be written.** If bad code still compiles, add a lint or CI check whose error names the file, type, or function to use instead. If the pattern is already common, fail only when a change adds more.
3. **Test the behavior.** Fix or delete any test that still passes when the behavior it checks breaks, or that fails when only the internals change.
4. **Write docs or agent rules last, only for judgment calls.** Nothing fails when an agent skips them.

## Fix and prove

Fix the selected class at the smallest boundary that prevents the demonstrated mistake. Prove each new check fails on a real past mistake, then passes with the fix. Use `implement`'s verification record and recovery checkpoint; CI supplies its required independent run. Exceptions go on the offending line with a reason, an expiry date, and a human's approval.

## Keep the rule table

For judgment calls that still need a written rule, update its existing authoritative location and name the enforcement or remaining limitation. When enforcement makes a rule redundant, remove the rule. A correction does not require another instruction table or authorize an unrelated architecture change.

**Reply:** each class with its evidence, the level you picked, and why a higher level didn't work.
