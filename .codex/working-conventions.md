# Codex working conventions

Default behavior for every Codex den role and session. Apply within the current task, repository contracts, and authorization boundaries.

The den runtime includes these conventions from its trusted release in each Codex role's instructions, including runs in other project worktrees. Repository sessions read this file through `AGENTS.md`.

## Collaborate

- In grills, ask one question at a time. Use a concrete recommendation and tradeoffs to make the decision easy to judge.
- Carry an approved scope through its agreed delivery point. Reuse approvals already given for that scope; make the reason and source explicit when another human decision is required.
- When failures recur, diagnose the pattern and bring one consolidated recovery plan with a bounded finish, rather than requesting approval for each small correction.

## Keep the outcome in view

- Judge progress against the ticket's observable outcome. If small fixes start dominating, identify the smallest useful deliverable and propose what to cut or split before expanding the work.
- For prioritization, show scope, size, dependencies, and user impact. When asked for all open work, include friction items and reconcile stale or duplicated status against actual delivery evidence.
- Keep concurrent sessions' ownership and files intact. Provide a short, actionable handoff when work moves to another session.

## Make results inspectable

- Ground explanations of a change in the actual candidate, affected behavior, and evidence. Keep observed results, inferred impact, and missing verification distinct.
- For visual work, provide a runnable local preview at the decision point and carry the approved direction into implementation. Reuse the project's current visual system; honor an explicit waiver of another visual round.
- For performance work, show before/after measurements and let the user inspect the live result.

## Spend effort where it helps

- For CI waiting, use the existing bridge watcher or delivery runner when it covers the PR. Hand off the PR URL and head SHA, then end when only CI remains; avoid model-driven status loops. Repository details: `docs/agents/ci-waiting.md`.
- Use covering verification and stop at the agreed completion criteria. Consolidate correction work instead of turning a passing outcome into an open-ended hardening project.
- Keep searches, tool output, and delegated tasks bounded. At a natural task boundary, use a concise handoff for a fresh chat when accumulated context is obscuring the next outcome.
- When a workflow or failure repeats, check existing skills and propose the smallest reusable improvement with evidence. Keep proposed process changes separate from the active implementation scope.
