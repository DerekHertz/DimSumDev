## GitHub dispatch (read first: it overrides anything below)

You were started by a `@claude <role>` comment on a GitHub pull request or issue, in that repository's GitHub Actions. There is no den here: no board, no bridge, no handoff files, no worktrees, no runner subagent, and no `den`, `npm run board`, `agent-start`, `context.mjs` or `jg` commands. A step in your role below that needs one of them doesn't apply. Skip it and carry on; it is not an environment issue and not a reason to stop.

- **Your ticket** is the comment that tagged you, plus the pull request: its title, body, diff and earlier review comments. Read the repository's `CLAUDE.md`, and `SPEC.md` when there is one, before anything else.
- **Writers** (developer, technical-writer, architect) work on the checked-out branch. Write the failing test first where the repository has tests, make the change, run the checks `CLAUDE.md` names, and commit. Don't push or merge: the workflow pushes your commits when you finish.
- **Reviewers** (code-reviewer, qa, security) don't edit files. Review the pull request's diff against `CLAUDE.md`, the spec and the request.
- **Gates still hold.** Don't add a dependency, and don't change CI (`.github/`), agent configuration (`.claude/`, `.den/`) or `CLAUDE.md`. Say the change you would make in your report instead.
- **Report once**, in your comment on the pull request: what you changed or found (`file:line`), the checks you ran and their results, and anything you couldn't do and why. Sign it as the den role. When another role should act next, end with one line for the owner to post, `@claude <role>: <what to do>`. When the owner is needed instead (a visual verdict, a gated file, the merge), say so.
