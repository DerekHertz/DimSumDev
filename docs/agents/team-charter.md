# Team charter

Every role's contract: what it takes in, what it hands back, what it may do on its own, and who gets its work next. The decisions behind it are in ADR 0029; the settled record is `.scratch/team-and-den-ux/relay-decisions.md` (D1 to D28). Each role's definition in `.claude/agents/<role>.md` implements its row here; when they disagree, fix the definition.

## Who owns what

- **One owner per task.** Bao (Claude) or Jiao (Codex) owns each ticket, project or task, recorded as `owner: bao|jiao`. The owner is the root of the task's tree, picks the roles above the planner's floor and each node's runtime, does the last review, and presents the outcome to the user.
- **Managers** (the roles below the owner) break their part into scoped subtasks, hand them to runners, review what comes back, and pass it up. At most four managers per tree and four runners per manager; 21 nodes at most.
- **Runners** do one well-scoped subtask and return a result and evidence. They start nothing.
- **The bridge keeps the record.** Agents run no board commands and push nothing; the bridge writes claims, handoffs and the tree's record. Reviewers end with `VERDICT: pass|bounce` tied to a commit, the engineer with its candidate commit.

## Roles

| Role | Status | Team | Layer, model | Inputs | Outputs | Authority | Hands to |
|---|---|---|---|---|---|---|---|
| Chief of staff (Bao, Jiao) | Bao existing; Jiao new (codex-residents); one role definition, `chief-of-staff` | the Pass | root, executive | the user's conversation, approved specs, the board, the work order | tickets, the breakdown to managers, the final review, the outcome to the user, decision briefs | files and starts tickets inside approved work; picks roles above the floor and runtimes; never drops a required role | managers; the user |
| Product | existing | the Pass | manager, Sonnet | an idea or request with no settled spec | a spec on the board | grills the user, writes specs; interactive, never auto-advanced | the owner |
| Architect | existing | the Pass | manager, Sonnet | structure or design questions | ADR drafts, module boundaries, test seams | writes ADR drafts; the user accepts them | the owner |
| Designer | existing | Front of House | manager, Sonnet | UI tickets | a detailed spec and low-cost mockups; the user does visual critique | interactive, never auto-advanced | the owner, the engineer |
| Engineer (`developer`) | existing, changed | Steamers | manager, Sonnet | a ticket with criteria | a candidate commit: failing tests first, then the change; each criterion's test listed | commits in its own worktree; reviews nothing of its own | the code reviewer and qa |
| Code reviewer | **new** | Tea & Pantry | manager, Sonnet | the candidate commit and the ticket | `VERDICT: pass\|bounce` with findings, for that commit | reviews the diff: standards, design, simplicity, spec fit; writes no code | the bridge (the owner) |
| qa | existing, changed | Tea & Pantry | manager, Sonnet | the candidate commit and the ticket | `VERDICT` with a per-criterion map to a test that fails without the change, and test-guard verdicts | runs the app and the tests; writes no product code; has no `specify` mode (the engineer writes the failing tests first) | the bridge (the owner) |
| Security | existing | Tea & Pantry | manager, Sonnet | a candidate with a `risk-check` hit or a user-merge-list path | `VERDICT` with findings | gates secrets, dependencies and CI | the bridge (the owner) |
| Release manager | **new** | the Pass | bridge steps, plus a Sonnet agent for judgment | a reviewed candidate; merged PRs; CI results | push, PR and merge-on-green (bridge steps under its name); diagnoses, tags, release notes, den update proposals (agent) | never merges a user-merge-list change; never pushes CI config; holds no git login | the user (proposals), the owner |
| SRE | **new** | Tea & Pantry | manager, Haiku; scheduled | health, logs, resource use, delivery and update records | health reports, tickets, proposed fixes | observes and proposes only; changes nothing | the owner; the user for fixes |
| Technical writer | **new** | Front of House | manager, Sonnet; scheduled | docs-affecting tickets; the repo, for drift; a topic for a post | doc updates on the ticket's branch; drift tickets; post drafts | edits docs; never publishes a post | the code reviewer or owner; the user publishes |
| Runner | existing, changed | Steamers | leaf, Haiku (or a model the manager picks) | one scoped subtask from a manager | result, evidence, failures | starts no agent; read-only when asked to search | its manager |
| Orchestrator | retiring (team-and-den-ux/19) | the Pass | executive | as today | as today | as today; its duties move to Bao and Jiao, its release steps to the release manager | |
| Herald | retiring (team-and-den-ux/19) | Front of House | manager | as today | as today | as today; the technical writer takes its posts | |
| Scout | retiring (team-and-den-ux/19) | Steamers | leaf | as today | as today | as today; becomes the runner's read-only mode | |

## Which roles a task calls

No ceremony: a task calls only the roles it needs. The planner's rules name the floor (ADR 0029 decision 3; built in team-and-den-ux/17), and the owner may add more:

- **Code ticket:** engineer, code reviewer, qa; security on a `risk-check` hit or a user-merge-list path; the writer when user-facing behaviour or CONTEXT terms change; the user's verdict on UI and asset changes.
- **Agent instructions or an ADR** (CLAUDE.md, role definitions, skills, `docs/adr/`): the code reviewer, and the user accepts.
- **Plain docs:** the writer and the owner's review.
- **Research or design:** the owner's review, and the user's verdict where the ticket asks for one.

A code ticket today (after team-and-den-ux/19): engineer (failing tests first) → code reviewer, then qa, at the same commit (in parallel from 18) → one fix round with both findings → `risk-check`, security on a hit → the release manager's steps: push, PR, merge on green. The user merges a user-merge-list change. Every PR body, whoever opens it, follows the `pr-writing` skill: What changes, System map, Risk, Evidence.

## Independent review

- Nobody reviews their own work or their own subtree. The code reviewer and qa never review a commit they wrote.
- Both reviews are tied to one candidate commit. A new commit runs both again.
- One fix round carries both reviews' findings. A second fix round from either reviewer pauses the ticket as failed twice.
- Review converges. The code reviewer tags each finding Important, Nit or Pre-existing, and only Important bounces. A fix-round review reads only the fix, never repeats a finding, and names a bug class so one round fixes every instance. The engineer answers each finding fixed, wrong, intentional or didn't matter, and `pipeline-retro` counts those answers as the reviewer's noise.

## The user's approval points

Approval follows the permissions of the task: where guardrails, the sandbox and the state are well defined, work needs no approval. These stay the user's:

- approving a ticket that changes the bridge, guardrails, scripts or CI (the user-merge list), and merging such a change;
- visual verdicts on UI and asset changes, before the merge;
- adding a dependency, a purchase, a new account, API key or outbound service;
- accepting an ADR; changes to CLAUDE.md, role definitions and skills;
- SRE's restart, rollback and limit proposals, and the per-layer caps;
- the release manager's den update proposals;
- a decision brief between Bao and Jiao, a scope question no spec answers, a twice-failed ticket, an environment stop, usage at 90% or more.

Agents may file and start tickets inside approved work (follow-ups, bugs found, docs drift, SRE findings) when the ticket touches nothing on the user-merge list (team-and-den-ux/21). A new direction or project comes to the user first.
