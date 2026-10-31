# Ticketing for agent teams: where mid-work fixes go, and how queues stay fresh

Date: 2026-10-31. Question: how do agent-first and small fast teams track work, and what should the den change so fixes found mid-work stop sinking?

Den today: markdown tickets under `.scratch/<feature>/issues/`, lock-file claims, statuses `ready-for-agent → claimed → in-review → resolved` plus `ready-for-human`, `blocked`, `parked`, `closed` (`docs/agents/issue-tracker.md`). The queue orders by P0, active feature, unblock count, P-level, number, with no aging (ADR 0015 Amendment 3). The `team-protocol` skill (`.claude/skills/team-protocol/SKILL.md`, line 20) says: "Every role files discovered work as a new ticket instead of chasing it." On 2026-10-30, 72 open tickets were closed in a reset. A count today gives 348 resolved, 305 closed, 16 parked, 6 ready-for-agent and 3 claimed, all still in the `issues/` folders agents scan.

Tags: **[verified]** means I opened the source and read the claim there. **[secondary]** means the claim came from a search-result summary or a third-party page.

## Practices

| Source | Practice | Evidence | Tag |
|---|---|---|---|
| Shape Up (Basecamp), ch. 7 | No backlog. Pitches that aren't bet on are dropped: "we let it go. There's nothing we need to track or hold on to." Backlogs are "a big weight we don't need to carry." "Really important ideas will come back to you." | https://basecamp.com/shapeup/2.1-chapter-07 | [verified] |
| Shape Up, ch. 7 | Lists are spread out: "There's no one backlog or central list." Programmers keep their own bug lists, and bugs get done in cool-down, the two-week break between cycles. | https://basecamp.com/shapeup/2.1-chapter-07 | [verified] |
| Shape Up, ch. 13 | Discovered tasks join the scope being worked on: "to-do lists actually grow as the team makes progress", and testing "populates the scope with new tasks for the issues found." | https://basecamp.com/shapeup/3.4-chapter-13 | [verified] |
| Shape Up, ch. 14 | Nice-to-haves are marked `~`. They are "things to do if the team has extra time at the end and things to cut if they don't", and "Usually they never get built." | https://basecamp.com/shapeup/3.5-chapter-14 | [verified] |
| Linear Method | "Keep a manageable backlog": you don't have to keep every request, and low-priority items can go. "Scope issues to be as small as possible." | https://linear.app/method/introduction | [verified] |
| Linear changelog | Auto-close and auto-archive are on by default for new teams and exist so nobody has to sift the backlog by hand. Auto-archive takes issues "closed for several months". | https://linear.app/changelog/2020-08-19-auto-close-and-auto-archive | [verified] |
| Linear docs | Auto-close cancels issues not updated in N months and sends a notification so they can be reopened. Auto-archive waits until the issue's cycle or project is done. | https://linear.app/docs/delete-archive-issues (search summary) | [secondary] |
| Linear Triage | Issues from integrations or from outside the team land in a Triage inbox, where someone accepts, declines, marks duplicate or snoozes each one. Triage duty can rotate, and AI suggests duplicates. | https://linear.app/docs/triage | [verified] |
| Beads (Yegge) | Agents "automatically file issues for newly-discovered work as they go" and link it back with the `discovered-from` dependency type. `bd ready` lists work with no open blockers. The README criticises "a swamp of rotten half-implemented markdown plans". | https://pkg.go.dev/github.com/steveyegge/beads@v0.21.1 | [verified] |
| Beads (current) | Atomic `--claim`. "Memory decay" summarises old closed tasks to save context. Storage is now Dolt, and `issues.jsonl` is only an export. | https://github.com/steveyegge/beads | [verified] |
| Thoughtworks Radar | Beads is in Assess (Apr 2026): "a persistent memory layer for coding agents", with ready-work detection and agents assigning tasks to each other. | https://www.thoughtworks.com/radar/tools/beads | [verified] |
| Gas Town | Work items are beads, bundled into "convoys" and slung to agents. Work state lives in a git-worktree "hook" that survives restarts. A blocker becomes a tracked bead through `gt escalate`. `gt done` creates a merge-request bead. | https://github.com/gastownhall/gastown | [verified] |
| Claude Code task list | A per-session checklist (pending, in progress, complete). It is shared across sessions only through `CLAUDE_CODE_TASK_LIST_ID`. | https://code.claude.com/docs/en/interactive-mode | [verified] |
| Claude Code agent teams | A shared task list with three states and dependencies that unblock themselves. Claims use a file lock, and teammates self-claim the next unblocked task. `TaskCreated` and `TaskCompleted` hooks can veto a task. Known limit: "teammates sometimes fail to mark tasks as completed". | https://code.claude.com/docs/en/agent-teams | [verified] |
| Codex cloud | Each task gets its own workspace and runs in parallel. Review, follow-up and PR happen inside the task, which is the unit of tracking. | https://learn.chatgpt.com/docs/cloud | [verified] |
| GitHub Copilot cloud agent | An issue is one entry point to a session, and some entry points open a PR automatically. | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/assign-copilot-to-an-issue | [verified] |
| Simon Willison | Small maintenance chores go to async agents. "the natural bottleneck on all of this is how fast I can review the results". He lands "one significant change at a time". He names no tracker. | https://simonwillison.net/2025/Oct/5/parallel-coding-agents/ | [verified] |
| Every compound engineering | The loop is plan → work → review → compound. Plans go in `docs/plans/` and lessons in `docs/solutions/`. Review is "Report-only". The README doesn't describe a follow-up tracker. | https://raw.githubusercontent.com/EveryInc/compound-engineering-plugin/main/README.md | [verified] |
| Every / Klaassen | "80% is in planning and review, 20% is in execution". No public benchmark backs the method. | https://developertoolkit.ai/en/method/principles/compound-engineering/ | [secondary] |
| Kanban Guide | "Limiting the work that is allowed to enter the system is an important key to reducing delay". WIP limits produce a pull signal. Replenishment policy (when, how much, by whom) should be explicit. | https://kanban.university/kanban-guide/ | [verified] |
| Google eng-practices | Refactorings go in a separate CL. "Small cleanups such as fixing a local variable name can be included inside of a feature change or bug fix CL." | https://google.github.io/eng-practices/review/developer/small-cls.html | [verified] |
| HN: "replaced Beads with Markdown tracker" | Flat files win on simplicity. One user had about 30 tickets after an hour, and the author has about 1,900. "risk in agents tripping over stale tickets and consuming tokens". Suggested fix: move closed tickets to a separate directory. | https://news.ycombinator.com/item?id=46487580 | [verified] |
| HN: "Beads" | "loads of markdown poop feels like the new .DS_Store". One user has a commit agent "remove documentation of completed work". Agents are asked to deduplicate notes. | https://news.ycombinator.com/item?id=46075616 | [verified] |

## Consensus

1. **The agent writes discovered work down the moment it finds it.** Beads, Gas Town `escalate`, agent-team `TaskCreate` and Shape Up's growing scopes all do this. Context runs out, so anything held only in the agent's head is lost. The den already has this rule.
2. **Discovered work links back to where it came from.** Beads has `discovered-from`, and Shape Up puts the task inside the current scope. The source carries responsibility for the follow-up.
3. **Something prunes the list on purpose.** Shape Up keeps no backlog. Linear auto-closes and auto-archives by default. Kanban caps what enters the system. HN users move closed tickets out of the agents' search path. No source treats a growing open list as healthy.
4. **Review capacity is the real WIP limit.** Willison says so directly, and Klaassen puts 80% of the effort in planning and review. Filing tickets is cheap for an agent, and reviewing them is the cost.
5. **The work unit and the PR are tied together** (Codex task, Copilot issue to PR, Gas Town MR bead). Auditability comes from the PR plus a short record, not from status ceremony.

## Disagreement

- **Keep it or drop it?** Shape Up drops everything not bet on. Beads and Gas Town keep every bead and count on queries and decay summaries to hide the old ones. Linear sits between: keep, then auto-close.
- **Fix in place or file?** Google allows small cleanups inside the current change but keeps refactors separate. Shape Up adds discovered tasks to the current scope and cuts `~` items at the deadline. Beads files everything as a new issue. The den follows Beads, filing everything, but has no `bd ready` style triage of the results.
- **How much structure?** Beads has a dependency graph and database. Its critics on HN want flat markdown and call Beads "an incredibly difficult-to-follow mess". The den is already on the flat-file side.
- **Who triages?** Linear uses a person on rotation, assisted by AI. Gas Town routes through Mayor and Deacon agents. Shape Up has no central triage: whoever cares lobbies again.

## Recommendations for the den

Each item names the current mechanism it changes.

1. **Fix forward by default, and file only what falls outside the current change.** A discovered fix that fits inside the ticket's files, is off the risk path and is roughly under 30 lines goes in the same commit as a separate checkbox under `## Comments` ("Fixed along: ..."). qa maps it like any other scope item (Shape Up ch. 13, Google small CLs). Anything else still becomes a ticket.
   *Changes:* `.claude/skills/team-protocol/SKILL.md` line 20, which today files everything. Line 18 already treats added scope as acceptance criteria, so qa needs no new rule.

2. **Record a `Discovered from: <ref>` line, and stop a parent from resolving while its children are untriaged.** The parent cannot resolve until each child is accepted, merged into another ticket or closed (Beads `discovered-from`).
   *Changes:* the ticket template in `docs/agents/issue-tracker.md` (around lines 37–38), the pre-write checks in `board resolve` (line 13), and a new finding in `apps/board/board-audit.mjs`. `**Origin:** added` already exists (`TICKET_ORIGINS` in `apps/board/board-service.mjs`, ADR 0015 Amendment 3 A), but it records *that* a ticket was added, not *from which* ticket, so it can't drive this check.

3. **Add a triage stop instead of filing straight to `ready-for-agent`.** Discovered tickets land at a new `triage` status. The chief of staff accepts, declines or marks each one duplicate in the same pass as `board resolve`, so triage happens every merge instead of in a 72-ticket reset (Linear Triage).
   *Changes:* the status list in `docs/agents/issue-tracker.md` line 9, `team-protocol` line 20 (which picks `ready-for-agent` or `ready-for-human` today), and `npm run queue`, which would show a TRIAGE column.

4. **Make tickets expire.** An open, parked or `ready-for-agent` ticket untouched for 21 days gets closed with reason `expired`, and `board reopen` brings it back. This makes "important ideas come back" real (Shape Up, Linear auto-close). The idle check in `board audit` already finds these tickets (7-day default) but never writes, so this adds the action.
   *Changes:* `board audit` and `board close` in `docs/agents/issue-tracker.md` lines 14–15, and `apps/board/board-audit.mjs`.

5. **Cap the ready queue, not just the running agents.** `max_concurrent_agents: 2` limits work in flight, but nothing limits work waiting. Set an explicit replenishment cap, for example 12 tickets at `ready-for-agent` plus `triage`. Accepting past the cap means closing or merging one first (Kanban Guide).
   *Changes:* `checkAdmission` / `board gate` (ADR 0015 Amendment 3, `apps/board/frontier-queue.mjs`, tests in `apps/board/admission-gate.test.mjs`). The gate already caps `Origin: added` tickets at one-third of a feature's planned tickets. That cap is per feature and limits scope creep, but it doesn't limit the total ready count. Discovered tickets that fail the cap or the `Serves` form may be one way fixes sink, which is worth checking before adding a second cap.

6. **Keep one `~` sweep list per feature instead of single-line tickets.** Small, non-urgent follow-ups become `~` lines in `.scratch/<feature>/map.md`. They run as one batch ticket when the feature's last ticket resolves (Shape Up cool-down, Willison's batch of maintenance tasks for async agents), or they are cut. This also fits the "one outcome per PR" and outcome-sized-tickets preferences.
   *Changes:* `map.md` conventions in `docs/agents/issue-tracker.md` lines 53–57, and `team-protocol` line 20.

7. **Move finished tickets out of the folder agents scan.** Move resolved and closed tickets to `.scratch/<feature>/done/` at resolve or close. Today 653 of the 678 ticket files sit in `issues/` and cost agents tokens on every frontier scan or grep (HN, Beads memory decay).
   *Changes:* the "Frontier" scan and the "Resolve" step in `docs/agents/issue-tracker.md` lines 56–57, and the `board resolve` and `board close` code under `apps/board/`.

## Minimum ceremony that keeps the audit trail

Across sources, the record that matters is the PR plus a short note of why. Gas Town has the MR bead, Codex the task log, and Linear the canceled-with-notification record. The den's lock file, handoff and `board resolve --pr` already cover this. Recommendations 1–7 add one field and one status, and remove the need for periodic mass resets.
