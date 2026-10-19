// den-mvp outcome 3: the den's view of a delivery. Deliver is offered for software tickets only and once per ticket; a
// delivery says where it stands in the bridge's own words; one that waits on the user is a Needs you request with its
// reason and next action, and one that will start by itself is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverState, deliveryLine, deliveryFacts, deliveryRows, deliveryRequests, deliveryOf, prLink } from "./delivery-model.mjs";
import { needsYouModel } from "./overlay-model.mjs";
import { applyEvent } from "../state/apply-event.mjs";
import { createBridgeClient } from "../state/bridge-client.mjs";

const SHA = "b".repeat(40);
const d = (more = {}) => ({ id: "d-0123456789abcdef", ref: "fx/08-plain", title: "08: Plain", state: "running", step: "developer", pause: null, candidate: null, bounces: 0, evidence: { qa: null, security: null, risk: null, ci: null }, pr: null, live: null, runs: [], ...more });
const paused = (kind, more = {}) => d({ state: "paused", pause: { kind, reason: `because ${kind}`, next: "Resume to try again." }, ...more });
const ready = { state: "ready" };

test("Deliver is offered for a software ticket, once, and says why it is off", () => {
  const ticket = { ref: "fx/08-plain", type: "feature" };
  assert.deepEqual(deliverState({ ticket, snapshot: { deliveries: [] }, steer: ready }), { show: true, enabled: true, reason: null });
  assert.equal(deliverState({ ticket: { ref: "fx/03", type: "design-question" }, snapshot: {}, steer: ready }).show, false);
  assert.equal(deliverState({ ticket, snapshot: {}, steer: { state: "none" } }).reason, "Couldn't send: not signed in to steer");
  assert.equal(deliverState({ ticket, snapshot: {}, steer: { state: "ready", demo: true } }).enabled, false);
  assert.equal(deliverState({ ticket, snapshot: {}, steer: ready, inflight: true }).reason, "Starting…");
  assert.equal(deliverState({ ticket, snapshot: { deliveries: [d()] }, steer: ready }).reason, "Being delivered");
  assert.equal(deliverState({ ticket, snapshot: { deliveries: [d({ state: "closed" })] }, steer: ready }).enabled, true, "an ended delivery does not block a new one");
  assert.equal(deliveryOf({ deliveries: [d({ state: "merged" }), paused("stopped")] }, "fx/08-plain").state, "paused");
});

test("a delivery's line says where it stands, and its facts are what the bridge recorded", () => {
  assert.equal(deliveryLine(d()), "The developer is working");
  assert.equal(deliveryLine(d({ step: "code-reviewer" })), "The code reviewer is reading the commit"); // team-and-den-ux/02
  assert.deepEqual(deliveryFacts(d({ candidate: { sha: SHA }, evidence: { review: "bounce", qa: "pass" } })).slice(0, 3), ["commit bbbbbbb", "code review bounce", "qa pass"]);
  assert.equal(deliveryLine(d({ step: "ci", pr: { number: 7 } })), "Waiting for the checks (#7)");
  assert.equal(deliveryLine(paused("ci-red")), "Waiting: because ci-red");
  assert.equal(deliveryLine(d({ state: "merged", pr: { number: 7 } })), "Merged as #7");
  assert.equal(deliveryLine(d({ state: "closed" })), "Closed, not merged");
  assert.deepEqual(deliveryFacts(d({ candidate: { sha: SHA }, bounces: 1, evidence: { qa: "pass", security: "pass", risk: { clean: false, hits: 2 }, ci: "green" } })), ["commit bbbbbbb", "qa pass", "risk check: 2 hits", "security pass", "GitHub checks green", "sent back 1 time"]);
  assert.deepEqual(deliveryFacts(d()), []);
});

test("a pull request link is an https URL or nothing", () => {
  assert.equal(prLink(d({ pr: { number: 7, url: "https://github.com/o/r/pull/7" } })), "https://github.com/o/r/pull/7");
  assert.equal(prLink(d({ pr: { number: 7, url: "javascript:alert(1)" } })), null);
  assert.equal(prLink(d()), null);
});

test("the list shows what is under way first, then the newest ended, and Stop only on a running one", () => {
  const rows = deliveryRows({ deliveries: [d({ id: "d-1", state: "merged" }), d({ id: "d-2", state: "closed" }), d({ id: "d-3" }), paused("stopped", { id: "d-4" })] });
  assert.deepEqual(rows.map((r) => r.id), ["d-3", "d-4", "d-2", "d-1"]);
  assert.deepEqual(rows.map((r) => r.canStop), [true, false, false, false]);
});

test("a waiting delivery is a Needs you request with its reason and next action; one waiting for room is not", () => {
  const snapshot = { tickets: [], deliveries: [paused("ci-red", { pr: { number: 7, url: "https://github.com/o/r/pull/7" } }), paused("no-room", { id: "d-2" }), d({ id: "d-3" })] };
  const [only, ...rest] = deliveryRequests(snapshot);
  assert.equal(rest.length, 0);
  assert.equal(only.kind, "delivery");
  assert.equal(only.reason, "because ci-red");
  assert.equal(only.next, "Resume to try again.");
  assert.deepEqual(only.primary, { action: "resume", label: "Resume" });
  assert.equal(only.pr, "https://github.com/o/r/pull/7");
  assert.deepEqual(deliveryRequests({ deliveries: [paused("visual-verdict")] })[0].primary, { action: "resume", verdict: "approve", label: "Approve and merge" });
  const needs = needsYouModel(snapshot, Date.now());
  assert.equal(needs.count, 1);
  assert.equal(needs.requests[0].key, "delivery:d-0123456789abcdef");
});

test("a delivery change frame adds or replaces the delivery", () => {
  const state = { seq: 1, tickets: [], deliveries: [d()] };
  const next = applyEvent(state, { seq: 2, type: "delivery", delivery: paused("stopped") });
  assert.equal(next.deliveries.length, 1);
  assert.equal(next.deliveries[0].state, "paused");
  assert.equal(applyEvent(state, { seq: 2, type: "delivery", delivery: d({ id: "d-9" }) }).deliveries.length, 2);
  assert.equal(applyEvent({ seq: 1, tickets: [] }, { seq: 2, type: "delivery", delivery: d() }).deliveries.length, 1);
  assert.equal(applyEvent(state, { seq: 2, type: "delivery", delivery: {} }), null);
});

test("the client sends a delivery's start and its steering, and nothing it was not given", async () => {
  const calls = [];
  const client = createBridgeClient({ fetch: async (url, init) => (calls.push([url, init.method, JSON.parse(init.body)]), { ok: true, status: 201, json: async () => ({ delivery: d() }) }) });
  await client.deliver({ ref: "fx/08-plain" });
  await client.deliver({ text: "  Add a health route.  " });
  await client.steerDelivery("d-0123456789abcdef", "resume", { verdict: "approve" });
  await client.steerDelivery("d-0123456789abcdef", "stop");
  await client.steerDelivery("d-0123456789abcdef", "close");
  assert.deepEqual(calls, [
    ["/deliveries", "POST", { ref: "fx/08-plain" }],
    ["/deliveries", "POST", { text: "Add a health route." }],
    ["/deliveries/d-0123456789abcdef/resume", "POST", { verdict: "approve" }],
    ["/deliveries/d-0123456789abcdef/stop", "POST", {}],
    ["/deliveries/d-0123456789abcdef/close", "POST", {}],
  ]);
  await assert.rejects(client.deliver({}), { reason: "Write what to build first." });
  await assert.rejects(client.steerDelivery("d-1", "merge"), { reason: "Unknown action." });
  assert.equal(calls.length, 5);
});

// den-mvp/34: the checks run on this machine, beside GitHub's.
import { checksView } from "./delivery-model.mjs";

test("den-mvp/34: a delivery shows its local checks beside GitHub's, and a disagreement names the differing facts", () => {
  const tests = { state: "green", record: `${SHA}/20261015T120000Z`, reason: null, failed: [], flaky: ["test-browser: camera fit"], commands: ["node scripts/test-split.mjs rest", "npm audit --audit-level=high"], differences: ["bwrap: present here, absent on GitHub"] };
  const row = deliveryRows({ deliveries: [d({ candidate: { sha: SHA }, evidence: { qa: "pass", risk: { clean: true, hits: 0 }, tests, ci: "red" } })] })[0];
  assert.deepEqual(row.facts, ["commit bbbbbbb", "qa pass", "risk check clean", "checks here green", "GitHub checks red"]);
  assert.equal(row.checks.mismatch, true);
  assert.equal(row.checks.summary, "Here: green · GitHub: red · they disagree");
  assert.deepEqual(row.checks.differences, ["bwrap: present here, absent on GitHub"]);
  assert.deepEqual(row.checks.commands, ["node scripts/test-split.mjs rest", "npm audit --audit-level=high"]);
  assert.deepEqual(row.checks.flaky, ["test-browser: camera fit"]);
  assert.equal(row.checks.record, `.scratch/_run/checks/${SHA}/20261015T120000Z`);
});

test("den-mvp/34: no disagreement while one side has no result, and a flaky run counts as passing", () => {
  assert.equal(checksView(), null);
  assert.equal(checksView({ here: { state: "red" } }).mismatch, false);
  assert.equal(checksView({ here: { state: "flaky" }, github: "green" }).mismatch, false);
  assert.equal(checksView({ here: { state: "skipped" }, github: "red" }).mismatch, false, "a skipped run says nothing about the code");
  assert.equal(checksView({ here: { state: "red" }, github: "green" }).summary, "Here: red · GitHub: green · they disagree");
  assert.equal(checksView({ github: "pending" }).summary, "Here: not run · GitHub: pending");
});

test("den-mvp/34: a red pull request card carries the latest local run of its commit, and whether one is running", () => {
  const rec = { sha: SHA, id: "20261015T120000Z", state: "green", commands: [{ name: "test", command: "node scripts/test-split.mjs rest" }], differences: [{ fact: "cores", here: "1", github: "4" }], failed: [], flaky: [] };
  const snapshot = { ci: { prs: [{ number: 9, sha: SHA, state: "red", url: "https://github.com/o/r/pull/9", jobs: [{ name: "test", reason: "1 test failed" }] }] }, checks: { recent: [rec], running: [] } };
  const card = needsYouModel(snapshot, Date.now()).requests.find((r) => r.kind === "ci");
  assert.equal(card.checks.mismatch, true);
  assert.deepEqual(card.checks.differences, ["cores: 1 here, 4 on GitHub"]);
  assert.deepEqual(card.checks.commands, ["node scripts/test-split.mjs rest"]);
  assert.equal(card.canRunChecks, true);
  assert.equal(card.checksRunning, false);
  const running = needsYouModel({ ...snapshot, checks: { recent: [], running: [SHA] } }, Date.now()).requests.find((r) => r.kind === "ci");
  assert.equal(running.checksRunning, true);
  assert.equal(running.checks.here, null);
  assert.equal(needsYouModel({ ci: snapshot.ci }, Date.now()).requests.find((r) => r.kind === "ci").canRunChecks, false, "a bridge without checks offers no button");
});

test("den-mvp/34: a checks frame replaces the den's list of local runs", () => {
  const next = applyEvent({ seq: 4, checks: null }, { seq: 5, type: "checks", checks: { recent: [], running: [SHA] } });
  assert.deepEqual(next.checks, { recent: [], running: [SHA] });
});

test("den-mvp/34: runChecks posts only the pull request number", async () => {
  const calls = [];
  const client = createBridgeClient({ fetch: async (url, init) => (calls.push([url, init]), { ok: true, status: 202, json: async () => ({ sha: SHA }) }) });
  await client.runChecks({ pr: 9 });
  assert.equal(calls.at(-1)[0], "/checks");
  assert.deepEqual(JSON.parse(calls.at(-1)[1].body), { pr: 9 });
  await assert.rejects(client.runChecks({ pr: "9" }), /No pull request/);
});
