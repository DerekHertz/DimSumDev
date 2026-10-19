# A role's conversation is durable, and a follow-up continues an ended run's session in a new run

## Amendment: project, runtime and role identify a conversation

Approved by the user in the Codex residents plan (codex-residents/01). This supersedes the one-file-per-role assumption in decision 1 and the bridge-session/CLI-session equivalence in decision 3. A conversation is identified by project, runtime and role. Omitted runtime and historical records mean Claude; unknown explicit identities never default. The bridge's UUID `sessionId` and each execution's `runId` are distinct from a runtime-minted `runtimeSessionId`. Follow-up preserves the complete tuple and runtime session while minting a fresh execution and resource group.

The den/Claude role file remains in place. Other tuples use `conversations/projects/<project>/<runtime>/<role>.jsonl`. Legacy Claude history is attributed through validated saved run metadata and read without relocation; missing run metadata belongs to den. Histories may be read for any onboarded project, but ordinary execution still requires the active project. Query/body runtime and project selectors do not grant cross-project or cross-runtime authority.

**Status:** proposed with the build (den-mvp outcome 2, `.scratch/den-mvp/spec.md` section 5). The user accepts it by merging the PR. It amends ADR 0016: decision 3 (two routes), decision 4 (the approval view and the transcript entries) and amendment 12 (messages).

**Context.** The den showed a live transcript per agent, kept in memory: it was lost on a bridge restart, and when a run ended there was no way to continue it except a new task that knew nothing. The user asked to talk to a panda and come back to it (spec stories 2 to 5), to see why an agent asks before granting anything (story 10), and to know that a stop or a note arrived (organism-infra/230, signed off 2026-10-12).

## Decision

### 1. One conversation per role, kept by the bridge

- Every transcript entry the host records is also appended to `.scratch/_run/conversations/<role>.jsonl` (directory 0700, file 0600, git-ignored), tagged with `runId` (the agent id) and `ref` (its ticket). A changed entry is appended again as a patch under the same `runId` and `id`. A run opens with `{ id: 0, kind: "run", mode, resumeOf }`.
- The project is the bridge's root, so one file per role is one conversation per role and project. Two runs of a role stay apart by `runId`.
- `GET /conversations/:role?before=&limit=` (token-gated) answers `{ entries, more, before }`: the newest page by default, the page above it with `before`. History is asked for; it does not ride the snapshot.
- The files are untrusted input, like `sessions.jsonl`. A read checks every field against a per-kind list, cleans every string again, copies no unknown key, and folds patches so that one can change only how an entry turned out (`status`, `result`, `note`, `answeredAt`), never its kind, time, ticket or text. Nothing read from them is authority: they are shown, never run. Only the newest 4 MiB of a file is read back.
- A tool's input is not written there. A permission entry carries `approvalId`, then the user's `note` and `answeredAt`; the command and the reason stay on the approval, which the bridge holds in memory.

### 2. A message into a conversation

`POST /conversations/:role/message { text, runId? }` (token-gated, mutating) is the thread's one way in.

- It goes to the run it names, or with none named to the role's one live run, else to its newest run. Two live runs and no name is a 409: routing is never a guess.
- A live run takes it as a message (amendment 12, unchanged): 202 `{ runId, messageId, resumed: false }`.
- A run that has ended is followed up: 201 `{ runId, messageId, resumed: true, agent }`.

### 3. A follow-up is a new run that resumes the session

- The new run has its own agent id, its own slot and its own resource group. It keeps the ended run's `sessionId` and runs in the same worktree (the one the first run of the session was given: `origin`), because the CLI finds a session by its directory. The adapter passes `--resume <sessionId>` in place of `--session-id`; nothing else in the argv template moves.
- Nothing of the old run is authority for the new one. Usage, the enforcement preflight, room and the earlier run's grants are checked again as for any start, and the runtime compiles the ceiling afresh from the current files. A refusal starts nothing.
- Grants live in memory. After a bridge restart a follow-up starts with the role's own rights and no task grants.
- The worktree must still be a worktree of this repository at the derived path, or the follow-up is refused with "start a new task instead". A failed follow-up never removes the earlier run's worktree.
- The user's text is the new run's first message. It carries a message id, so the same receipt applies: `queued`, then `applied` when the CLI replays it.
- A follow-up that commits nothing publishes no branch. One that commits gets `den/<ref>-<its own short id>`.
- `sessions.jsonl` spawn lines of a follow-up carry `resumeOf` and `origin`; replay keeps them only when both are bridge-minted ids and the worktree is the one derived from `origin`.
- A run with no recorded end (the bridge died under it) may still be alive in the worktree. Before a follow-up on its session the host asks the runtime, by unit name, whether that run's resource group is still there (`runtime.stillRunning`). While it is, or the answer cannot be read, the follow-up is refused.
- A claim lock on the follow-up's own ticket is not counted beside the run: once the run is live the capacity rule counts a ticket once, whoever holds its lock.
- An ended run holds no slot while it waits for a follow-up. Unrelated work is a new task, with a fresh session and worktree.

### 4. Why an agent asks, and what a stop leaves (organism-infra/230)

- The approval view gains `says` (what the agent last said before asking, since its last tool result or user message; cleaned, one line, at most 500 characters) and `intent` (the tool input's own `description`, at most 200), each null when there is none, and `answeredAt`.
- A stop that is accepted records `{ kind: "stop", status: "requested" }`; the `ended` entry closes it.
- The agent view gains `resumeOf` and `followUp` (true for an ended run whose session can be continued).

### 5. The thread in the den

The transcript panel becomes the conversation, as the signed-off 230 spec draws it: the ask leads with the reason and keeps the command under a disclosure, the user's answers, notes, messages and stops are entries with receipts, and the box and Stop (one-step confirm) sit at the foot. Receipts say what was sent and what the agent did next; none says the agent read anything. It differs from that spec in one place, on purpose: when a run has ended the box is not read-only but follows the run up (decision 3). The thread opens from a Needs you card and from the panda of an ended run, in or out of walk mode.

## Consequences

- A conversation survives a reload and a bridge restart; live processes still end with the bridge (unchanged).
- The conversation file grows without a cap; only reads are bounded. It holds cleaned agent and user text, so it is as sensitive as the transcript was.
- A fresh task does not receive a summary of the role's earlier conversation. The spec asks for "only relevant decisions and summaries"; none is injected yet.

## Not done here

Bao's own conversation behaviour, the board operations a follow-up developer would need to publish work, and meetings are later outcomes of the same spec.
