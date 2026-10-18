---
name: handoff
description: Compact the current work into a handoff document for the next cell to pick up. Use at the end of every cell's task (apoptosis), before exiting, or when the user asks for a handoff.
argument-hint: "What will the next cell be used for?"
---

Write a handoff document so a fresh cell can continue the work without reading this conversation.

Save it on the board, not in the OS temp dir: `.scratch/<feature-slug>/handoffs/<NN>-<cell-type>.md`, where `<NN>` is the ticket number you worked. If there is no ticket, use `.scratch/_handoffs/<YYYY-MM-DD>-<cell-type>.md`. Overwrite an earlier handoff from the same cell type on the same ticket. Draft the file under `/tmp` (`board handoff` refuses a draft inside any worktree), then publish it with `npm run -s board -- handoff <feature>/<NN-slug> --from <file> --name <NN>-<cell-type>.md`. It refuses to overwrite another cell's handoff. Never Write to the main checkout's path directly; the harness blocks it. Then append a one-line pointer to the ticket's `## Comments`.

Before you write an orchestrator session handoff (`.scratch/_handoffs/<YYYY-MM-DD>-orchestrator-<N>.md`), run `npm run -s session-check` in the main checkout and fix every item it prints: local `main` ahead of `origin/main`, uncommitted board files under `.scratch/`, and in-flight tickets whose handoff branch is missing from or behind `origin`. Each item carries its fix command. A cell in a worktree skips this: `board release` pushes its branch.

Keep it under 60 lines. Start the file with a fenced `json` State block (ADR 0009 decision 4). `board release --status in-review|resolved` parses the `json` State block of the ticket's handoffs and refuses the release if none is valid. The block must name its author: `"cell"` (your cell type) and, for moded cells, `"mode"` (e.g. qa `specify` or `verify`). A handoff whose `cell`/`mode` differ from your claim, or that was written before your claim, doesn't count (ADR 0008 decision 11). Write the handoff after claiming and before releasing. `npm run -s board -- handoff <feature>/<NN-slug> --template` prints this block with the ticket, cell and mode filled in:

```json
{"ticket": "<feature>/<NN>", "cell": "<your cell type>", "mode": "<mode, if any>", "current_step": "one line: where the work stands",
 "artifacts": ["paths you changed or wrote"], "decisions": ["choices not in an ADR or the ticket"],
 "failures": ["what failed or was refused, or leave empty"],
 "pending": [{"item": "what's left", "owner": "<next cell type>"}]}
```

`pending` is `[]` when nothing is left. Otherwise every item needs a non-empty `item` and a named `owner`. You can't hand back an interim status with unowned work. Validate the block with `validateState` from `apps/organism-infra/schemas.mjs` if you're unsure.

Then these sections:

- **State**: done / partial / blocked, in one line.
- **What changed**: branch name and commit SHAs. Reference diffs, specs, ADRs, and tickets by path; don't duplicate them.
- **Decisions made**: only ones not already in an ADR or the ticket.
- **Next step**: the single next action, and which cell type should take it.
- **Suggested skills**: the skills the next cell should load.
- **Gotchas**: anything that cost you time.

Keep it environment-neutral. The next session may start locally (WSL) or in a cloud container, so don't record setup for the environment you happened to run in: env vars, binary paths, proxy workarounds, missing tools, or a session's own board branch. Environment facts belong in `docs/agents/cloud-sessions.md`; the handoff names that file if it matters. Refer to merged work by PR or `main`, not by a session branch.

Record state, not rules. Don't paraphrase a genome, skill, or ADR rule in a handoff; name the file instead. The next session will follow your paraphrase, including anything it dropped.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If arguments were passed, treat them as what the next cell will focus on and tailor the doc accordingly.

<!-- Adapted from mattpocock/skills productivity/handoff (MIT). See .claude/skills/VENDORED.md. -->
