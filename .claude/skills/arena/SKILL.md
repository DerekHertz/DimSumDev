---
name: arena
description: "Run N parallel candidates at one task, pick a base, graft the best of the rest. 'Arena this'."
---

# Arena

Open a todolist with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Use the `arena runners` line in `~/.claude/rules/pstack-models.md`. If the rule or that line is missing, default to one `opus` at `high` effort and one `sonnet` at `high` effort. Each entry `<model> <effort>` becomes `model: "opus"` and `effort: "high"` on the Agent call. `model` takes only opus, sonnet, haiku, or fable. An `auto` or `inherit-parent` entry, or a non-Claude one, omits `model`, so the runner runs on the parent model. If the Agent tool rejects a value, use the nearest valid one and say so. If a seat cannot run, drop it and say so. If fewer than two runners remain, add runners until there are two, or one when the line has one entry. Run each added runner on a remaining runner's model, or omit `model` so it runs on the parent model when none remain, and say so. Spawn more runners when the arena covers multiple design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive. Pick each runner's effort for the job.
4. Give each candidate its own output location: a git worktree (`isolation: "worktree"`) where possible, otherwise a `candidate-<n>/` directory under the arena's output folder, per the separate-before-serializing-shared-state principle in `../architect/references/principles.md`.

## Phase B: Fan out

Spawn all N runners as Agent calls (`subagent_type: "general-purpose"`) in one message, each with `isolation: "worktree"`, the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, choose one model from the `arena cross-judge pool` line in `~/.claude/rules/pstack-models.md`. If the rule or that line is missing, the pool is `sonnet` at `high` effort and `fable` at `high` effort. Map each entry as in Phase A step 3. An `auto` or `inherit-parent` entry is the parent model, so it never judges.

Pick a model from the pool on a different tier than the parent when possible. If you cannot tell the parent's tier, try the pool in order and say that the family check did not run. If the Agent tool rejects an entry, use the nearest valid one and say so. If no pool entry runs, skip the judge, pick the base alone in Phase D, and say so.

Spawn one readonly judge subagent. The judge sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the redesign-from-first-principles principle in `../architect/references/principles.md`, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the prove-it-works principle in `../architect/references/principles.md`. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
