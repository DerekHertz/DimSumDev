---
name: no-comments
description: "Delete comments that narrate the code, and turn 'do not remove' comments into a type, test or lint. Use before committing a large diff."
---

# No comments

A comment must say something the code cannot. Review the comments in scope and delete or encode the rest. Scope is the caller's files or diff; otherwise the diff against `main`, working tree included.

## What survives

- Legal and license headers.
- Behavior forced by an external dependency, platform, vendor or protocol we cannot reshape.
- `prettier-ignore`, and lint suppressions whose rule is faulty or style-only.
- Doc comments that define a public API contract.
- A link to an issue or RFC that explains a constraint the code cannot express.

Doubt kills a comment. Narration, banners, commented-out code and workaround explanations die.

## Steps

1. Read the comments in scope. For each, decide: keep (one exception above), delete, or `MUST KILL`.
2. `MUST KILL` is a surprise in our own code explained by prose. Rename, extract, type or restructure so the behavior is obvious, then delete the comment. A `eslint-disable`, `@ts-ignore` or similar suppression that guards correctness or safety is also `MUST KILL`: remove the suppression and fix the cause.
3. `IMPORTANT`, `do not remove`, `too risky` and long justifications are scent, not proof. Before accepting one as a keep, check its symbol: read its callers and `git log -S` on it. A keep stays only when the constraint is proven live and outside our control.
4. A constraint comment (`do not change wording`, `talk to X first`) gets an offer of the cheapest in-scope encoding: a type, a runtime check, a test or a CI lint. Ask the user; in an unattended run the dispatch must have pre-approved it. If approved, encode then delete. If not, delete the comment and report the constraint as unenforced.
5. Touch comments and the smallest root-cause fix only. If the root cause is outside scope, land the smallest in-scope fix and report the rest as open.
6. Report: deletions, `MUST KILL` fixes, encoding offers and results, unenforced constraints, open work.

For a fresh view, run steps 1 to 3 in a `code-reviewer` or `runner` leaf and keep the edits in your own context.

<!-- Adapted from pstack no-comments and the comment-sicko agent (MIT, Lauren Tan). See .claude/skills/VENDORED.md. -->
