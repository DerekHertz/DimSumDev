# A delivery is a bridge job: developer, independent qa, the checks, a pull request and a guarded merge

> Terms: written before ADR 0028, which renamed the vocabulary (cell → agent, cell type → role, genome → role definition, station → team, organism → the org, apoptosis → hand off and exit).

**Status:** proposed with the build (den-mvp outcome 3, `.scratch/den-mvp/spec.md` sections 1, 4 and 8). The user accepts it by merging the PR. It builds the relay runner of ADR 0022 in a different shape and amends it: decision 1 (the plan reads the job's own record, not handoffs), decision 5 of its user answers (board writes are bridge calls now) and decision 6 (the bridge opens the pull request and merges). It builds ADR 0021 steps 4 and 6 for one job.

**Context.** After outcome 1 any panda can be given a job, and after outcome 2 the user can talk to it. Software still could not reach `main` from the den: an agent behind the wall cannot write the board (it is outside its worktree), holds no git-host credential, and nothing connected a developer's commit to a review, a pull request or a merge. The spec asks for "scoped board operations, appropriate routing, independent verification, PR and guarded merge" to "complete one approved job".

## Decision

### 1. The job, and what approves it

`POST /deliveries { ref }` (token-gated) starts a delivery on a frontier ticket of a software type (`feature`, `bug`, `chore`, `task`, `ui`, `asset`). With `{ text }` instead, the board service first writes a ticket for the text under `den/`. The click is the user's approval of the ordinary path for that ticket and nothing wider. One ticket has at most one delivery that is running or waiting.

The job is the bridge's own record: the commit `main` was at when it started (`base`, fetched from the remote), the candidate commit, the evidence, the bounce count, the runs. `apps/bridge/delivery/plan.mjs` exports one pure function, `nextStep(job)`, that says what is next. **Every piece of evidence names the commit it was made for and counts only while that commit is the candidate.** A new commit asks for every check again.

| The job has | Next |
|---|---|
| no candidate | `developer`, in a worktree at `base` |
| a candidate with no qa verdict for it | `qa` `verify`, in its own worktree at the candidate |
| a `bounce` (qa or security) | `developer` again at the candidate, with the findings; the second bounce pauses the job |
| a qa pass, no check result | the scripted checks, run by the bridge |
| a check that asks for security | `security` at the candidate |
| the reviews it needs | push the candidate, open the pull request |
| a pull request | wait for its checks, then read them |
| green checks, mergeable, nothing that is the user's | merge, then resolve the ticket |

### 2. What an agent does, and what the bridge does for it

A delivery step is started through the host's internal `start()`, so usage, the enforcement preflight, room and the wall apply as to any run. Its prompt is a fixed template over the role, the ref, the ticket's path and a commit id.

- The agent works in its worktree and commits there, or reviews and commits nothing. It runs no board command and does not push.
- The bridge records where the run started and ended (`git rev-parse` in the worktree), and its last message. **A reviewer's verdict is one line of that message, `VERDICT: pass` or `VERDICT: bounce`.** It is counted only for the commit the bridge checked out for the review, and only if the reviewer left that commit where it was.
- The bridge makes the board calls, through the board service, for the job's ticket only: it claims the ticket for the step's role when the run has started, writes the handoff (its own State block, then the agent's message as a report), releases at `in-review`, and resolves after the merge. A step that fails gives the claim up and puts the status back.
- A fix round is a new developer run at the candidate. The review's message is written to `.den/findings.md` in its worktree; `.den/` is added once to the repository's own `info/exclude`, so no commit carries it. The worktree is at a commit an agent made, so whatever that commit left at `.den` is removed first, without being followed, and the file is created new.

No agent → bridge call exists. The agent's words are read after it ends, as data.

### 3. The checks the bridge runs itself

Before anything is pushed the bridge, from its own checkout, reads the changed paths, looks for a secret, and runs `scripts/risk-check.mjs` on the range.

- The secret check reads every commit that would be pushed, not the difference of the two ends, with binary files read as text. A line that matches a secret pattern, or a file named like a key or an environment file, pauses the job. Nothing is pushed. A secret assembled from parts at run time is not seen.
- A risk hit, or a changed path on the user-merge list, sends the candidate to `security`.
- **The user-merge list** is the governance guardrail and CI paths, every dot path at the repository root (`.github`, `.agents`, `.cursor`, `.gitattributes`, `.npmrc` and whatever a new tool adds), `apps/bridge/**`, `apps/organism-infra/**`, `apps/ci-cd/**`, `scripts/**`, `mods/**`, `CLAUDE.md`, `AGENTS.md`, `package.json`, `package-lock.json` and `skills-lock.json`. These are the enforcement, the board and gate code, and what runs by itself on the user's machine or the git host. A change to any of them is reviewed by security, opened as a pull request, and then waits: the review and the merge are the user's. The bridge never merges a change to its own enforcement. What the bridge may merge by itself is the rest: the UI, `packages/`, the docs and design files.
- **A change to CI configuration is not pushed at all.** A workflow runs on the git host the moment its branch is pushed, with whatever it declares for itself. The job pauses as `ci-change` and names the local branch; the user pushes it and opens the pull request if it is right.
- The candidate must be built on `base`. A commit made elsewhere in the history pauses the job.
- The changed paths are read with renames off, so a file moved out of a listed directory still counts as a change there.

### 4. Push, pull request, merge

`apps/bridge/delivery/git-host.mjs` holds the only git-host calls: fetch `main`, diff, push one commit to one `den/…` branch, find or open the pull request, read it, watch its checks, merge with `--match-head-commit`. Each is a fixed argument list over a full commit id, a derived branch name or a number. They run with the bridge process's own `git` and `gh` login; no agent is given it, and the wall still denies `git push` and `gh pr` to every agent.

- What is pushed is the commit the bridge recorded, by id. The first developer run names the branch; a fix round moves the same branch forward, so a job has one pull request.
- The pull request's title is the ticket's ref and title. Its body is the bridge's facts. No agent text is in either.
- Before a push the bridge looks for the pull request, so a repeat opens nothing twice. The merge reads the pull request again at that moment: open, at the candidate commit, every check finished and passed (and at least one check), mergeable. Merges run one at a time. A push, an open and a merge each check, with nothing awaited in between, that the job was not stopped since its step began. After the merge the bridge reads the state once more, and resolves the ticket only when the git host says it is merged.
- A UI or asset ticket waits for the user's visual verdict before the merge (`resume` with `verdict: "approve"`), and the verdict is for one commit.

### 5. Pauses, Stop and Resume

A delivery stops at the first thing that is the user's and says why and what to do next: `failed-twice`, `no-commit`, `no-verdict`, `changed-commit`, `step-failed`, `stopped`, `possible-secret`, `ci-change`, `publish-failed`, `ci-red`, `no-checks`, `ci-pending`, `conflict`, `not-mergeable`, `pr-closed`, `guardrail`, `visual-verdict`, `usage`, `busy`, `board`, `environment`, `bridge-restart`. `no-room` is the one wait that ends by itself, when a run ends.

`POST /deliveries/:id/stop` pauses the job and stops its running step. `…/resume` forgets what the git host said, asks it again, and goes on; after `failed-twice` it is one more round. `…/close` ends a waiting delivery; the ticket, the branch and any pull request stay.

The runner holds no timer and polls nothing. It moves when a run ends, when a git-host call returns, or on a click. The wait for checks is one `gh pr checks --watch` child.

### 6. The record

The delivery log is `delivery.jsonl` in the bridge's state directory: under the user's state home in production (`~/.local/state/den/projects/<id>/`), so it is in no worktree and under no path a task can be granted. It holds the job's record after each change, and an intent and an outcome line around each side effect (claim, release, push, pr, merge, resolve).

On a restart every field is checked and unknown keys are dropped. **What the git host said is never read back**: the pull request and its checks are asked for again. A job that was under way waits as `bridge-restart` and says which operation was cut short; nothing runs until the user's Resume. The claim of the run that ended with the bridge is given up first.

### 7. In the den

The snapshot gains `deliveries` and the change type `delivery`. The Stations card lists deliveries with one line each and a Stop, offers Deliver on a software ticket, and takes a change typed with no ticket. A delivery that waits is a Needs you request with its reason, the next action, the recorded facts, the pull request link, and Resume and Close.

## Consequences

- `main` can change with no terminal: a developer commit that an independent qa run passed, that the scripted checks passed or security passed, and that the repository's own checks passed on the pull request. Branch protection on the git host still applies on top; a merge it refuses is a `publish-failed` pause.
- The verdict of a review is an agent's claim. It decides whether the bridge goes on, and it is not the only gate: the checks on the pull request are observed from the git host, and a change to the enforcement is never merged by the bridge.
- Board writes by delivery agents are gone (ADR 0022 user decision 5 asked to measure them first; the wall made them impossible for a headless run, so they are bridge calls now). A direct task still follows the organism protocol as before.
- ADR 0022's hop planner over board handoffs is not built. Its tickets (organism-infra/231 to 233) are superseded by this ADR for den-started delivery. The terminal relay is unchanged.
- The bridge's `gh` and `git` credentials are the user's own, with their full scope. The narrow argument lists are the bound, not the token.

## Not done here

- Bao does not yet propose a delivery from a conversation, and no orchestrator session is woken at a pause: the pause is shown on Bao's card in Needs you.
- The genomes in `.claude/agents/` still describe the board commands; a delivery step's prompt overrides them. The protected-file change is for the user's review path.
- Jev's tier and verify depth, a tree of jobs, and delivery in another repository (outcome 6) are later.
- After a merge the main checkout is not updated and nothing is rebuilt or served (outcome 5).

## Amendment 1: previews and going live (ADR 0026, den-mvp outcome 5)

- **What is visual** (decision 1). A delivery also waits for the user's verdict when its candidate changes what the UI is built from (`apps/ui/` and `packages/`), whatever its ticket type. The scripted checks record it as `risk.ui`, and security reviews every such change.
- **Where the verdict is** (decision 5). For such a change the bridge builds a preview of the candidate after qa, the checks and (on a hit) security, and the `visual-verdict` pause comes before the push. One approval covers the push, the pull request, the merge on green checks and going live. A visual ticket that changes nothing under `apps/ui/` keeps its verdict where it was, after the checks on the pull request.
- **Decline.** `POST /deliveries/:id/resume { verdict: "decline", note }` sends the developer round again with the note. Declines are counted in `declines`, apart from `bounces`, and never cause `failed-twice`. A preview that does not build is a failed check and counts as a bounce.
- **After the merge.** For a change under `apps/ui/` the bridge makes a release of the merge commit and switches the served UI to it, then resolves the ticket. Two new pauses: `go-live-failed`, and `needs-update` when the merged commit differs from the running bridge's release under `apps/bridge/` or in the lockfile. Resume finishes the go-live. `needs-update` is also the pause for a candidate whose lockfile has no packages folder.
- **The record** (decision 6). The log keeps `declines`, `evidence.preview` and a finished `evidence.live`, and `golive` is an operation with an intent and an outcome. A go-live that did not finish is asked again on Resume. A waiting preview is served again after a restart from `previews/<job id>/`; one whose folder is gone waits as `bridge-restart`.
- **In the den** (decision 7). A delivery's row gains `ui`, `preview: { url, sha }` while one is open, `verdict`, `declines` and `release`.

