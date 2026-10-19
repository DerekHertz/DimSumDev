// den-v1/06 (user decision 2026-10-08): a dev-only `?demo=approval` mode. It seeds one pending approval through a stub
// bridge, so the review panel can be seen and tried in `npm run ui` with no live runtime. Pure data and a tiny store;
// App.jsx turns it on only when import.meta.env.DEV is true, and it is a different value of `demo` from the handoff
// demo (`?demo=handoff`), which keeps A and D off. `&refuse=<status>` makes every answer fail with that status.
// den-v1/07 fix round 1: the same stub also takes a message (T) so every composer state can be seen. sendMessage resolves {ok, messageId}
// with no network; about 2 s later a fixture `message-ack` for that id goes to onEvent listeners. A message containing `noack` gets none.
const REF = "demo/01-approval";
const AGENT_ID = "demo-agent-1";
const EXPIRES_IN_MS = 10 * 60 * 1000;
const REASONS = {
  400: "The answer was not understood.",
  401: "The session token was not accepted.",
  404: "No such permission request.",
  409: "This request was already answered.",
  429: "Too many answers; wait a moment.",
  500: "The bridge hit an error.",
};
// Longer than the card's 200-character summary on purpose: the panel must show all of it.
const INPUT = {
  command: "find apps/ui/src -name '*.test.mjs' -newer package.json -print0 | xargs -0 grep -l 'approval' | sort | tee /tmp/approval-tests.txt",
  description: "List the UI tests that mention approvals, newest first, and keep a copy for the review.",
  timeout: 120000,
};
const ACK_DELAY_MS = 2000;
const INPUT_LENGTH = JSON.stringify(INPUT).length;

export function approvalDemoParams(search, dev) {
  if (!dev) return null;
  const params = new URLSearchParams(search ?? "");
  if (params.get("demo") !== "approval") return null;
  const refuse = Number(params.get("refuse"));
  return { refuse: Number.isInteger(refuse) && refuse >= 400 && refuse <= 599 ? refuse : null };
}

const failure = (status, reason) => Object.assign(new Error(reason), { status, reason });

export function createApprovalDemo({ now = Date.now, refuse = null, schedule = setTimeout } = {}) {
  const listeners = new Set();
  const eventListeners = new Set();
  let messageSerial = 0;
  let serial = 0;
  let approvals = [];
  let agentState = "needs-you";
  let snapshot;

  const ticket = {
    ref: REF, feature: "demo", title: "approval", type: "feature", status: "claimed", ready: false,
    holder: { role: "developer", since: new Date(now()).toISOString() }, lastRole: "developer", gate: null, blockedBy: [],
  };

  function build() {
    snapshot = {
      schema: 1, seq: ++serial, tickets: [ticket], frontier: [], usage: null, requests: [], placements: [],
      agents: [{
        id: AGENT_ID, ref: REF, role: "developer", state: agentState, tool: "Bash",
        capabilities: { approve: true, send: true },
      }],
      approvals,
    };
  }
  function arm() {
    approvals = [{
      id: `demo-approval-${serial + 1}`, agentId: AGENT_ID, tool: "Bash", status: "pending",
      summary: INPUT.command.slice(0, 200), inputLength: INPUT_LENGTH, expiresAt: new Date(now() + EXPIRES_IN_MS).toISOString(),
    }];
    agentState = "needs-you";
    build();
  }
  const emit = () => { for (const fn of listeners) fn(); };
  const find = (id) => approvals.find((a) => a.id === id);

  arm();

  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    rearm() { arm(); emit(); },
    onEvent: (fn) => { eventListeners.add(fn); return () => eventListeners.delete(fn); },
    client: {
      async sendMessage(agentId, { text } = {}) {
        if (refuse) throw failure(refuse, REASONS[refuse] ?? `The bridge refused the request (${refuse}).`);
        if (agentId !== AGENT_ID) throw failure(404, "No such agent.");
        const messageId = `demo-message-${++messageSerial}`;
        if (!/noack/i.test(String(text ?? ""))) {
          schedule(() => { for (const fn of eventListeners) fn({ type: "message-ack", agentId, messageId }); }, ACK_DELAY_MS);
        }
        return { ok: true, messageId };
      },
      async getApproval(id) {
        const a = find(id);
        if (!a) throw failure(404, REASONS[404]);
        if (a.status !== "pending") return { ...a, input: null, state: a.status };
        return { ...a, state: "pending", input: INPUT };
      },
      async decide(id, { decision } = {}) {
        if (refuse) throw failure(refuse, REASONS[refuse] ?? `The bridge refused the request (${refuse}).`);
        const a = find(id);
        if (!a) throw failure(404, REASONS[404]);
        if (a.status !== "pending") throw failure(409, REASONS[409]);
        approvals = approvals.map((x) => (x === a ? { ...x, status: decision === "allow" ? "allowed" : "denied" } : x));
        agentState = "running";
        build();
        emit();
        return { ok: true };
      },
    },
  };
}
