### Multi-phase or multi-PR plan

**You own the plan, not the code. The plan is a checklist the owner runs box by box and the user audits from the evidence.** The plan is the deliverable. Do not implement.

1. When the change is one or two files with an obvious approach, skip the plan. Say so and stop.
2. Settle open questions by prototype before you write. Call the Skill tool with `prototype` for each. Keep the branch, the SHA, and the screenshots for Appendix A. Ask the user only about a product or preference call that no run can settle. Give options. Decide reversible calls yourself and tell the user afterward.
3. Explore with `runner` or `Explore` subagents. Each returns file pointers, conventions, test commands, and entry points. No inlined dumps.
4. Write the plan under `docs/` unless the user names a path. Fill every placeholder. Keep every heading and sub-block in the order shown below. One PR unit is one board ticket at `.scratch/<feature>/issues/NN-slug.md`, filed with the `to-tickets` skill. Name the relay in **How to read this**.
5. Hand back. Post the plan path, then stop. Execution starts on the user's explicit go.

**Verification.** Tests alone are not sufficient verification. A unit is verified by the relay: the developer writes failing tests first, then `code-reviewer` and qa `verify` review the commit, then `npm run risk-check` runs, and `security` runs on a hit. A unit that changes an interaction also needs its live block checked. A unit on a measured path also needs its perf block checked.

````markdown
# <Program> plan

<Under ten lines. What changes, for whom, the rule the program enforces, and the ticket ids in order.>

## How to read this

One box is one unit of work. Check a box only when its evidence exists: a file, a log line, a screenshot, a test run, or a commit SHA. The body is a how-to. The appendices explain and record.

The program runs the relay in the `team-protocol` skill, sized by its "Relay size" rules. <Who merges: the bridge in a delivery, or the chief of staff in a terminal relay. Which ticket ids stop at merge-ready for the user.>

Tests alone are not sufficient verification. A unit is verified only when its unit box is checked, and its live and perf boxes too where the diff changes an interaction or a measured path.

## Program checklist

### Arm the program

- [ ] State this plan and the relay to the user, then stop. Start only on the user's explicit go.
- [ ] Read `../team-protocol/SKILL.md` and `docs/agents/team-charter.md` at program start.
- [ ] Mark each risk-path unit (wall, CI, hooks, service, auth, dependencies). The user merges those.

### Spawn owners

- [ ] Give each ticket to the developer role, which writes the failing tests first.
- [ ] Follow this dependency graph. Start a unit only after its parent merges.
  - [ ] <ticket id> and <ticket id> are independent and first. Both start from `main`.
  - [ ] <ticket id> after <ticket id>.
- [ ] Hold the file boundaries. <ticket id or class> touches only `<glob>`. Up to two workers run at once.
- [ ] Hold the review gate. <ticket ids> change a UI or an asset. They wait for the user's visual critique in chat before merge.

### PR mechanics, for every PR

- [ ] The developer commits and does not review its own work.
- [ ] Rebase onto current `main` before the code-ready report. Rebase again only on a merge conflict, or on a CI failure caused by a change on `main`.
- [ ] Push, PR and merge are the release manager's steps. The bridge runs them in a delivery, and the chief of staff in a terminal relay. The plan's agent never pushes, opens or merges.

### Verdict and merge

- [ ] `code-reviewer` and qa `verify` review the commit together. One fix round carries both reviews' findings.
- [ ] Run `npm run risk-check`. A clean exit skips `security`. A hit dispatches it.
- [ ] Judge each finding by the blocking rule in `team-protocol`. The verdict is clean when none blocks. A new head gets a fresh verdict.
- [ ] Merge on green CI. A red or conflicted merge stops the relay.

## <Task as a verb phrase> (<ticket id>)

**Depends on.** <ticket id, or None.>

**Files.**

- [ ] Edit `<path>`.
- [ ] Create `<path>`.
- [ ] Delete `<path>`.

**Build.**

- [ ] <One change. Name the symbol and the file.>

**You see.**

- [ ] <One observable result, with the exact log line or screen state.>

**Verify, unit.** Tests alone are not sufficient verification. Qa `verify` maps each acceptance criterion to a test that fails without the change.

- [ ] <Test file and the case it gains.> Run `<command>`.

**Verify, live.** Only where the diff changes an interaction. Tests alone are not sufficient verification. Run one live scenario per interaction the diff changes, driven through the `browser-verify` skill for UI or the real CLI otherwise, each with a saved artifact and a pass predicate.

- [ ] Regression check against `main`. Run <the same load-bearing scenario> on `main` and on the branch. If `main` lacks the feature, record that and gate <the behavior the diff adds plus the end state the user waits for>. Save `<slug>.png`. Pass when <predicate>.
- [ ] <Scenario.> Save `<slug>.png`. Pass when <predicate>. One box per further interaction.

**Verify, perf.** Only where the diff changes a measured path. Tests alone are not sufficient verification.

- [ ] Metric. <What is measured on both `main` and the branch. If `main` lacks the feature, also name the diff-added work and the end-to-end state the user waits for.>
- [ ] Probe. <The command or procedure, run on `main` and on the branch, interleaved. Both sides must produce the metric.>
- [ ] Baseline. Record the `main` <value> first.
- [ ] Rule. <Branch against `main`, with the number that fails. If the scenarios differ, set absolute budgets for the diff-added work and the user-visible end state instead of a ratio.>

**Review gate.** The user reviews before merge. UI and asset tickets only.

- [ ] Post the live screenshots in chat. Stop at merge-ready. Wait for the user's verdict.

**Merge.**

- [ ] Clean verdict at the exact head SHA.
- [ ] Rebased onto current `main` after the verdict, with the patch-id unchanged.
- [ ] The release manager merges on green CI.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the user with the report the relay names.

## Appendix A. Prototype evidence

<Each open question a prototype answered, with the branch, the SHA, and the artifact paths. Each question that stays unproven.>

## Appendix B. Alternatives rejected

<Each approach weighed and why it lost.>

## Appendix C. Risks

<Each risk with the ticket it lands in and what the owner watches.>

## Appendix D. Links and reading list

<Docs to read before editing. The trail under `.scratch/<feature>/`, and the `how` and `interrogate` skills for the tickets that need them.>
````

**Reply:** the plan path, the ticket ids with their dependencies and the review-gated set, and what the prototypes proved and what stays unproven.
