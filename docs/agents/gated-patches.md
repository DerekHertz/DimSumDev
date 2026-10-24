# Gated patches: edits only the user can apply

Agents can't edit `.claude/` (role definitions, skills, settings) or `CLAUDE.md`. When an agent needs one of those changed, it writes a patch and the user applies it with one command. Don't write `.sh` or `.mjs` apply scripts or paste heredocs for this; they pile up and a pasted heredoc can hang the terminal.

## For an agent that needs a gated edit

1. Make the change on a scratch copy of the file (outside the gated path), then produce a patch with `git diff` or `git format-patch`. A `format-patch` file carries a commit message; a plain diff gets a generic one naming the file.
2. Save it as `.scratch/_handoffs/gated/<NN>-<slug>.patch` in the main checkout. `<NN>` is the ticket number, so patches sort in the order to apply. Patch paths are relative to the repo root (`a/.claude/agents/developer.md`).
3. Name the patch in your handoff and tell the chief of staff the user should run `!npm run apply-gated`.

## For the user

Run `!npm run apply-gated` inside Claude Code (or `npm run apply-gated` in a terminal) from the main checkout.

For each `*.patch` in `.scratch/_handoffs/gated/`, in file-name order, it prints the target worktree, the diff stat and the full patch, then asks `Apply <name>? [y/N]`.

- Only `y` applies. `n`, Enter, anything else, or end of input skips the patch and leaves it in place.
- `git apply --check` runs first. A patch that fails the check is reported and left in place; nothing is partially applied. So does a patch whose target files already have uncommitted edits, because the commit takes those files whole.
- An applied patch is committed (only the paths it touches, so other dirty files in the checkout stay out of the commit) with the patch's own message, then moved to `.scratch/_handoffs/gated/applied/`. The patch queue itself is never committed.
- With nothing pending it prints `nothing to apply` and exits 0. It exits 1 if any patch failed.

Read the printed diff before answering `y`: that review is the gate. The script never runs patch content: git calls use argument arrays with no shell, and `.sh` or `.mjs` files in `gated/` are ignored.
