---
name: pr-writing
description: "PR body for this repo: What changes, System map, Risk, Evidence, with a generated system map. Use when opening or editing a pull request or drafting PR text."
---

The PR body is written for the user at merge time. They should be able to decide "is this safe, and is it what I wanted?" in under a minute without opening the diff. The bridge's Delivery, Claude sessions and Codex all write the same four sections in the same order, so the author never changes how the user reviews.

## Steps

1. Commit the work, then run `npm run -s pr-map` on the branch. It diffs from the merge-base with `origin/main` (pass `--base <ref>` or `--head <ref>` to change that) and prints the System map block and the blast radius. Done when you have its output; never draw or edit the diagram by hand.
2. Write the body below, pasting the map block as printed. Done when every section is filled and nothing in it comes from memory rather than the diff and the checks.
3. Once pushing is authorized (a pass gate: your role and dispatch allow it, or the user said yes), open the PR (`gh pr create --body-file <file>`), and end the body with the attribution lines the session gives you.

## The four sections

~~~markdown
## What changes

Two to four sentences on behavior: what the user or the system now does differently.

```diff
- before: <the old behavior, one line>
+ after: <the new behavior, one line>
```

## System map

<the pr-map block: Mermaid diagram, legend, any collapse or unmapped line>

## Risk

**Door:** two-way. <one sentence: why, and the undo step>
**Blast radius:** <the list pr-map printed>

## Evidence

<details><summary>Tests, checks and files</summary>

- Tests: <the command and its result>
- CI: <status>
- Review: <who reviewed, verdict>
- Risk check: <clean, or the hits and the security verdict>
- Files: <the changed files, one per line>

</details>
~~~

**What changes** is about behavior, not code. "The den shows a stuck delivery's reason on its card" beats "Add `reason` to `DeliveryCard` props". Name the user-visible or system-visible difference; leave function names, file names and line counts to the Evidence fold. The `diff` block holds one or two `- before` / `+ after` lines, which GitHub shows in red and green. A pure refactor says so: `- before: <behavior>` / `+ after: same behavior, <what is now easier>`.

**System map** is pr-map's output, pasted whole. If it prints an `Unmapped:` line, add the paths to an area in `docs/system-map.json` on the same branch and run it again, rather than leaving them unmapped.

**Risk** carries the door and the blast radius:

- A **two-way door** can be undone cleanly: reverting the merge restores the old behavior, with no data, state or outside party left changed. Name the undo step: "revert the PR", "revert, then `npm run den:update`" for a bridge change, "turn the flag off".
- A **one-way door** leaves something that a revert does not undo: a migration or rewrite of board files or user state, a published post or release, a deleted file or branch, a changed public interface someone outside the repo uses, credentials or branch protection changed. Say what can't be undone and what the plan is if it goes wrong.
- When unsure, call it one-way and say why. The blast radius is pr-map's list, copied, never written by hand.
- Codex: this section replaces the "Merge Danger" heading.

**Evidence** sits folded so it doesn't push the change out of view. Report what ran and its result, including failures, as summaries: no raw test or log output, since the body may be public. Name a secret's location, never its value. No line counts.

## The map

`docs/system-map.json` declares the areas (each with path globs) and the links between areas that imports can't show (HTTP, the board CLI, roles to skills). Inside an area a module is a file with its tests folded in (`rig.test.mjs` belongs to `rig`), or one child folder for an area's `folders` (assets, skills, mods). Arrows inside and between areas come from ESM imports. A module is edited when the PR changes it, and rippled when it directly uses an edited one; ripple stops after one hop, and a test importing a module doesn't ripple. Past 25 edited or rippled modules the map collapses to areas with their edited counts and says so. A new top-level folder fails `scripts/pr-map.test.mjs` until an area claims it.
