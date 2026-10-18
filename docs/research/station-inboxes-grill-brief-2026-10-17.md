# Grilling brief: pull-based station inboxes

**For:** the `architect` cell, in a grilling session with the user (skill: `grilling`). **Output:** an ADR (next free number after 0026), or a written "no, and why". Nothing is built from this brief; it authorizes no ticket.

**Origin (user, 2026-10-17):** while looking at guard follow-up L11 (a guard rerun and a checks run share the 4 GiB `den-checks` slice, so two concurrent deliveries can OOM each other), the user proposed borrowing from MCS locks and tree barriers. Each role gets a queue. Its upstream and downstream roles hold statically assigned slots in it. Work fills the queue and the role pulls from it, instead of work moving on PR events and single pass-offs. The user expects this to help the 24/7 goal (north star, 2026-10-12: agents roam and find work, the user talks to each, meetings, a chief of staff, running 24/7).

## What exists today (verify before relying on it)

- **Board:** local markdown under `.scratch/`, claims by atomic lock file (`npm run board -- claim`). Already pull-shaped: a cell claims a ready ticket or fails. See the `organism-protocol` skill.
- **Dispatch is push:** the orchestrator picks the next unblocked ticket and starts cells. `max_concurrent_cells: 2` (`apps/bridge/cells/capacity.mjs`), plus a reserved slot for Bao and one for a scout. The code relay: qa `specify`, developer, qa `verify`, `risk-check` (clean skips security), security, then PR and merge on green. ADR 0022 (relay through the bridge), ADR 0024 (delivery jobs).
- **Resource groups:** per-class limits and an aggregate in `apps/bridge/cells/limits.json`. Checks and the test guard share `den-checks` (4 GiB, 1024 tasks). The bridge refuses a run it cannot enforce limits on.
- **Meetings (ADR 0017):** up to six specialists, one take each, in sequence, then a decision brief. The nearest thing to a join today.
- **Spec line to reconcile:** `.scratch/den-mvp/spec.md` puts "unattended queue operation and 24/7 autonomous building" out of scope for the MVP. It says these follow evidence from daily use, and that future queue execution is limited to already-approved work.

## The idea, stated as plainly as I can

1. Each station (product, architect, developer, qa, security, ...) has an **inbox**.
2. An inbox has a **fixed number of lanes**, one per upstream producer, so producers never contend on the same write. The consumer drains lanes in a fair order: FIFO within a lane, round-robin across lanes.
3. A role **pulls**. Nothing is pushed or triggered by a PR event.
4. Where several results must all be present before work continues (qa, security and a second verifier; meeting takes), a **join** counts arrivals.
5. Scarce resources (checks memory, cell slots, the usage window) get a bounded queue in front, so a second user waits instead of OOMing the first. That is the L11 case.

## What I think holds and what doesn't (the architect should attack this)

- MCS gives FIFO, local waiting and a one-successor handoff, which maps to fairness and no thundering herd. It does not map to cache-line contention; ours is over scarce resources.
- A tree barrier pays off at large N. Here N is 2 to 6, so a flat counter probably suffices.
- "Static slots" cannot be per ticket, because tickets are dynamic. Per station and per upstream role is the only reading that works.

## Questions to settle (one at a time, with a recommended answer each)

1. **What problem comes first?** Resource contention (L11), unattended 24/7 running, or decoupling stations? The answer decides whether this is a bridge-internal resource queue or a board-level change.
2. **Where does an inbox live?** In the board (markdown plus locks), in the bridge's memory, or in a durable file the bridge owns? What survives a bridge restart or `den:update`?
3. **What is a lane, concretely?** Per upstream role, per ticket stream, or per project (ADR 0025: client projects have their own board)? What happens when the upstream set changes?
4. **Capacity and backpressure.** What bounds each inbox, and what does a producer do at the bound: wait, drop, or escalate to the user?
5. **Who wakes a puller?** Polling, a bridge event, or the orchestrator? Which of the orchestrator's jobs disappear, and which stay (batching, approvals, usage-watch at 90%)?
6. **Failure.** A cell dies mid-pull. Today there is `board reclaim`. In the new model, is it a lease with a timeout, or a dead-letter lane? How does it meet the "twice-failed ticket" stop?
7. **Joins.** Which joins are real today (verifier, security, and Codex verifying per ticket 73), and does a counter in the inbox beat the current "verdicts on the ticket" approach?
8. **Gates.** User approval, pass gates and "a bridge change is left for the user to merge" must survive. Where does each gate sit when nobody dispatches?
9. **Scope and order.** What is the smallest slice that gives value (for example one inbox in front of `den-checks`, then one station), and what evidence from daily use would justify the rest, by the spec's own rule?
10. **Cost of the process.** The user found the relay too restrictive: no new process or tunnelling on non-urgent work, one outcome per PR, no token, cost or time caps on agents. How does this add structure without adding ceremony?

## Out of scope for the session

The guard follow-ups (L10 to L12) ship separately and do not wait on this. No code and no ticket writing; the architect may recommend a ticket split in the ADR.
