// showcase-v1/04: a scripted run for demoing handoffs without a live daemon. Open the UI with
// ?demo=handoff and the snapshots below play in a loop (App.jsx). Pure data.
const ticket = (n, title, over = {}) => ({
  ref: `demo/${String(n).padStart(2, "0")}-${title}`, feature: "demo", title, type: "feature", status: "ready-for-agent",
  ready: true, holder: null, lastRole: null, gate: null, blockedBy: [], ...over,
});
const held = (cell) => ({ role: cell, since: "2026-09-29T05:00:00.000Z" });
const snap = (tickets, frontier = []) => ({ schema: 1, seq: 1, tickets, frontier, usage: null, requests: [] });

const queued = ticket(3, "queued-idea");
const spec = (over) => ticket(1, "add-login", over);

/** Each step is what the daemon would report next; the demo advances every STEP_MS. */
export const DEMO_STEP_MS = 4000;
export const DEMO_STEPS = [
  // qa writes the tests
  snap([spec({ status: "claimed", holder: held("qa") }), queued], [queued.ref]),
  // qa hands over: the ticket is ready again, last worked by qa (basket only, no panda)
  snap([spec({ lastRole: "qa" }), queued], [spec().ref, queued.ref]),
  // developer picks it up: tea -> steamers handoff
  snap([spec({ status: "claimed", holder: held("developer") }), queued], [queued.ref]),
  // developer finishes; security reviews: steamers -> pantry
  snap([spec({ status: "in-review", holder: held("security") }), queued], [queued.ref]),
  // the orchestrator waits on the user to merge: lantern and bell light
  snap([spec({ status: "in-review", lastRole: "security", gate: "merge" }), queued], [queued.ref]),
];
