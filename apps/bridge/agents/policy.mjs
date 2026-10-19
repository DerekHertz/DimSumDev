// organism-infra/140 (ADR 0016 decision 3): the steering host's policy values and role table, in one place.
// Mechanism lives in host.mjs; every number and allowlist a reviewer may want to change lives here.

// den-mvp outcome 1 (spec section 2): two worker slots, plus one slot kept for Bao (the orchestrator) and one for a scout.
// A reserved slot is never a third worker. Each class has its own hardware limits (limits.json, read by resource-group.mjs).
export const SLOT_CLASSES = ["worker", "bao", "scout"];
export const SLOTS = Object.freeze({ worker: 2, bao: 1, scout: 1 });
export const slotClassOf = (role) => (role === "orchestrator" ? "bao" : role === "scout" ? "scout" : "worker");
export const MAX_CONCURRENT_AGENTS = SLOTS.worker; // max_concurrent_agents (ADR 0002): worker agents plus foreign claim locks
export const SESSION_CAP = SLOTS.worker + SLOTS.bao + SLOTS.scout; // hard ceiling on live daemon-spawned sessions; a policy override can only lower it
export const KILL_GRACE_MS = 5000; // between stdin close, SIGTERM and SIGKILL
export const SHUTDOWN_SPAWN_WAIT_MS = 3000; // organism-infra/143: how long shutdown waits for spawns in flight before it kills synchronously
export const USAGE_REFUSE_AT = 90; // five-hour usage percent at which dispatch is refused (ADR 0002 auto-pause)

// The nine known agents (CLAUDE.md).
export const ROLES = ["product", "architect", "orchestrator", "developer", "scout", "qa", "security", "designer", "herald"];
// mode reaches the prompt template, so it is an allowlist, never free text.
export const MODES = ["specify", "verify", "review", "spec", "critique", "direction"];

// den-v1 loop S1 (ADR 0016 decision 3, amendment 9): tasks started from the den with POST /tasks.
export const DEN_FEATURE = "den"; // the board feature the route writes its tickets under
// den-mvp/30: Bao's desk, the ticket the user's ticket-free conversation with Bao runs on. The bridge writes it (parked, so
// it is in no queue and never worked); a run on it gets the desk prompt, not a ticket's.
export const DESK_REF = "den/00-bao";
export const DIRECT_MODE = "direct"; // set by the host for such an agent; not in MODES, so no client can ask for it
export const TASK_MAX_BYTES = 2048; // UTF-8 bytes of task text (the 2 KB message cap of decision 6.7)

// The director's states (ADR 0007). A runtime may report the live ones; the host alone decides the end states.
export const LIVE_STATES = ["working", "waiting_on_user", "blocked", "throttled", "idle"];

// ref: no segment starts with "-" (it must never look like a flag). Ticket numbers are two or more digits
// (ADR 0016 says \d{2}; the board has three-digit tickets such as 140).
export const REF_RE = /^[a-z0-9][a-z0-9-]*\/\d{2,}-[a-z0-9][a-z0-9-]*$/;
export const AGENT_ID_RE = /^c-[0-9a-f]{16}$/; // approval ids are a-
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// den-v1 loop S0 (ADR 0016 decision 3, amendment 7): where agent worktrees go and how their branches are named.
export const WORKTREES_DIR = ".claude/worktrees"; // repo-relative; git-ignored, and scripts/worktree-gc.mjs cleans it
export const WORKSPACE_BRANCH_PREFIX = "den"; // den/<ref>-<short agent id>; also the worktree directory's prefix

// organism-infra/141 (ADR 0016 decision 4 and 6.5, 6.7): held permission requests.
export const APPROVAL_TTL_MS = 10 * 60 * 1000; // an undecided approval expires, and the child is answered deny
export const QUESTION_TTL_MS = 4 * 60 * 60 * 1000; // den-mvp/37: an agent's question to the user waits far longer than a tool ask
export const APPROVAL_CAP_PER_AGENT = 20; // pending approvals per agent; the 21st expires the oldest
export const APPROVAL_ID_RE = /^a-[0-9a-f]{16}$/;
export const APPROVAL_NOTE_MAX = 500; // characters in a decision note
export const APPROVAL_INPUT_MAX = 256 * 1024; // serialised tool input; a bigger request is answered deny, never held
export const APPROVAL_HISTORY_CAP = 200; // settled approvals kept for the snapshot, oldest dropped first
export const REQUEST_ID_MAX = 128; // the child's opaque request id (ADR 0016 6.5)
export const REQUEST_IDS_PER_AGENT = 1000; // request ids remembered per agent; past it every request is answered deny

// The live transcript (den-v1 loop S2, ADR 0016 amendment 10). Small on purpose: the buffer rides every snapshot.
export const TRANSCRIPT_ENTRIES = 100; // entries kept per agent, oldest dropped first
export const TRANSCRIPT_AGENTS = 4; // agents whose buffer is kept; the oldest ended agent's goes first
export const TRANSCRIPT_TEXT_MAX = 4000; // characters of one message
export const TRANSCRIPT_RESULT_MAX = 2000; // characters of one tool result

// den-v1 loop S4: what a run reports about itself. All of it is agent output, so each value is checked before it is kept.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,63}$/; // a model id as the CLI names it, e.g. claude-opus-5-5[1m]
export const COST_MAX_USD = 100_000; // a reported cost above this is not believed
export const REPLY_EXCERPT_MAX = 280; // characters of the final reply kept on the agent, for the card
export const USAGE_MESSAGES = 200; // messages whose token counts are remembered, so a repeated one counts once

// den-v1 loop S5 (ADR 0016 amendment 12): a message to a running agent.
export const MESSAGE_MAX_BYTES = 2048; // UTF-8 bytes of one message (the 2 KB cap of decision 6.7)
export const MESSAGE_QUEUE_MAX = 8; // messages one agent may have written and not yet taken
export const MESSAGE_SETTLE_MS = 15_000; // how long an agent that reported done is kept up for a message it has not taken

// den-mvp outcome 2: the durable conversation a role has with the user (conversations.mjs). History is asked for a
// page at a time; it never rides the snapshot.
export const CONVERSATION_PAGE = 100; // entries in one page when none is asked for
export const CONVERSATION_PAGE_MAX = 200; // the most one page may hold
export const CONVERSATION_READ_BYTES = 4 * 1024 * 1024; // of one role's file, the newest part that is read back

// den-mvp outcome 4 (ADR 0025): what the bridge allows by itself for one run. A connection's read past either bound is
// asked, like any other request. This bounds what a run can send to a listed service with no question; it is not a cap on work.
export const CONNECTION_AUTO_CALLS = 30; // reads allowed without a question, per run
export const CONNECTION_AUTO_BYTES = 16 * 1024; // their inputs, added up, per run
