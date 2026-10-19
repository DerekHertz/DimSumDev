// den-v1 loop S1: T on a resident panda opens the same composer in start mode. Contract:
//   cardFor() marks a resident whose role the bridge can start with card.start === true and an enabled T.
//   composer.open(card) on such a card opens in start mode: overline "New task for <name>", placeholder
//     "Tell <name> what to do", note "One task, started as a new agent", sendLabel "Start", busyLabel "Starting".
//     (A card with a live agent keeps the message copy: note "One message, sent to this agent only", "Send", "Sending".)
//   Enter or Start calls client.startTask(role, { text }) -> { agent: { id }, ticket: { ref } }; never sendMessage.
//   On success it closes, announces "Task started for <name>." and statusFor(the card once the agent is bound)
//     is { agentId, kind: "started", label: "Task started", preview }.
//   A refusal keeps the text: "Not started. <reason> Press Enter to try again." A 401 is final, like a message.
//   Drafts are kept per panda. Demo mode opens nothing.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMessageComposer } from "./message-composer.mjs";
import { cardFor } from "./proximity-card.mjs";

const flush = () => new Promise((r) => setImmediate(r));
const rejectWith = (status, reason) => Object.assign(new Error(reason), { status, reason });
const viewer = { x: 0, z: 0, yaw: Math.PI / 2 };
const panda = (over = {}) => ({ id: "scout", name: "The Scout", role: "scout", station: "Steamers", position: { x: -2, z: 0 }, ...over });
const residentCard = (over) => cardFor([panda(over)], [], viewer);

function harness({ startTask } = {}) {
  const calls = [];
  const client = {
    sendMessage: async (...args) => { calls.push(["sendMessage", ...args]); return { ok: true, messageId: "m-1" }; },
    startTask: (role, body) => {
      calls.push(["startTask", role, body]);
      return (startTask ?? (async () => ({ agent: { id: "c-new" }, ticket: { ref: "den/01-scout" } })))(role, body);
    },
  };
  const composer = createMessageComposer({ client, now: () => 0 });
  return { composer, calls, state: () => composer.getState() };
}

describe("T on a resident opens the composer in start mode", () => {
  test("it opens with the task copy and sends nothing", () => {
    const h = harness();
    const r = h.composer.key({ key: "t" }, { card: residentCard(), mode: "walk" });
    assert.deepEqual(r, { handled: true, walk: false });
    const s = h.state();
    assert.equal(s.open, true);
    assert.equal(s.phase, "ready");
    assert.equal(s.overline, "New task for The Scout");
    assert.equal(s.ariaLabel, "New task for The Scout");
    assert.equal(s.placeholder, "Tell The Scout what to do");
    assert.equal(s.note, "One task, started as a new agent");
    assert.equal(s.sendLabel, "Start");
    assert.equal(s.busyLabel, "Starting");
    assert.equal(s.sendEnabled, false);
    assert.equal(h.calls.length, 0);
  });

  test("a card with a live agent keeps the message copy", () => {
    const h = harness();
    const live = { id: "c-1", state: "working", capabilities: { send: true } };
    h.composer.open(cardFor([panda({ agent: live })], [], viewer), { mode: "walk" });
    const s = h.state();
    assert.equal(s.overline, "Message The Scout");
    assert.equal(s.note, "One message, sent to this agent only");
    assert.equal(s.sendLabel, "Send");
    assert.equal(s.busyLabel, "Sending");
  });

  test("Enter starts the task for the panda's role with the trimmed text, and the card then shows it started", async () => {
    const h = harness();
    h.composer.open(residentCard(), { mode: "walk" });
    h.composer.setText("  Count the baskets.\n");
    h.composer.key({ key: "Enter", inBox: true }, { card: residentCard(), mode: "walk" });
    assert.equal(h.state().phase, "sending");
    await flush();
    assert.deepEqual(h.calls, [["startTask", "scout", { text: "Count the baskets." }]]);
    const s = h.state();
    assert.equal(s.open, false);
    assert.equal(s.announcement, "Task started for The Scout.");
    assert.equal(s.focusReturn, "scene");
    assert.equal(h.composer.statusFor(residentCard()), null, "nothing to show until the agent is bound to the panda");
    const bound = cardFor([panda({ agent: { id: "c-new", state: "working", capabilities: {} } })], [], viewer);
    assert.deepEqual(h.composer.statusFor(bound), { agentId: "c-new", kind: "started", label: "Task started", preview: "“Count the baskets.”" });
    // The line goes when that agent ends, and the clock never turns it into a stalled message.
    h.composer.tick();
    assert.equal(h.composer.statusFor(bound).kind, "started");
    h.composer.sync({ agents: [{ id: "c-new", state: "done" }] });
    assert.equal(h.composer.statusFor(bound), null);
  });

  test("a refusal keeps the text and says why; a retry sends again", async () => {
    let n = 0;
    const h = harness({ startTask: async () => { if ((n += 1) === 1) throw rejectWith(429, "max_concurrent_agents (2) reached"); return { agent: { id: "c-2" }, ticket: { ref: "den/02-scout" } }; } });
    h.composer.open(residentCard(), { mode: "walk" });
    h.composer.setText("Count the baskets.");
    await h.composer.send();
    let s = h.state();
    assert.equal(s.open, true);
    assert.equal(s.phase, "refused");
    assert.equal(s.text, "Count the baskets.");
    assert.equal(s.banner, "Not started. max_concurrent_agents (2) reached Press Enter to try again.");
    assert.equal(s.sendEnabled, true);
    await h.composer.send();
    s = h.state();
    assert.equal(s.open, false);
    assert.equal(h.calls.length, 2);
  });

  test("every refusal but a 401 can be retried; a 401 ends the session", async () => {
    for (const status of [0, 400, 404, 409, 500, 502, 503]) {
      const h = harness({ startTask: async () => { throw rejectWith(status, "no"); } });
      h.composer.open(residentCard(), { mode: "walk" });
      h.composer.setText("x");
      await h.composer.send();
      assert.equal(h.state().phase, "refused", `status ${status}`);
    }
    const h = harness({ startTask: async () => { throw rejectWith(401, "unauthorized"); } });
    h.composer.open(residentCard(), { mode: "walk" });
    h.composer.setText("x");
    await h.composer.send();
    assert.equal(h.state().phase, "final");
    assert.equal(h.state().banner, "Session ended. Restart the bridge and open the launch link it prints.");
  });

  test("a draft is kept per panda, and a snapshot with no such agent does not close the box", () => {
    const h = harness();
    h.composer.open(residentCard(), { mode: "walk" });
    h.composer.setText("for the scout");
    h.composer.sync({ agents: [{ id: "c-other", state: "done" }] });
    assert.equal(h.state().phase, "ready");
    h.composer.close();
    h.composer.open(residentCard({ id: "architect", name: "The Architect", role: "architect" }), { mode: "walk" });
    assert.equal(h.state().text, "");
    h.composer.close();
    h.composer.open(residentCard(), { mode: "walk" });
    assert.equal(h.state().text, "for the scout");
  });

  test("demo mode and an over-long task open or send nothing", async () => {
    const h = harness();
    assert.deepEqual(h.composer.open(residentCard(), { mode: "walk", demo: true }), { opened: false, reason: "Demo mode: actions are off" });
    h.composer.open(residentCard(), { mode: "walk" });
    h.composer.setText("x".repeat(2049));
    assert.equal(h.state().sendEnabled, false);
    await h.composer.send();
    assert.equal(h.calls.length, 0);
  });
});

describe("wiring", () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
  test("the composer renders the controller's labels, and the card names T by what it does", () => {
    const jsx = read("./MessageComposer.jsx");
    for (const field of ["state.note", "state.sendLabel", "state.busyLabel"]) assert.ok(jsx.includes(field), `MessageComposer.jsx renders ${field}`);
    const card = read("./ProximityCard.jsx");
    assert.match(card, /card\.start/);
    assert.match(card, /Start task/);
    assert.match(card, /Opens the task box/);
  });
});
