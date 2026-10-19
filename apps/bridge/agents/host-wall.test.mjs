// agent-os/05: wall refusals mark the agent row by kind, with a transcript notice; the third of a kind pauses the
// agent and raises a request in Needs you; Keep refused and Grant for this task restart the count.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { until, makeBridge, send } from "./host-test-helpers.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const VIOLATION = (host) => `curl: (56) Received HTTP code 403\nX-Proxy-Error: blocked-by-allowlist\n<sandbox_violations>\ndeny network-outbound ${host}:443\n</sandbox_violations>`;
const WRITE = (p) => `Exit code 1\n/bin/bash: line 1: ${p}: Read-only file system`;

async function start() {
  t = await makeBridge();
  const { agent } = (await t.dispatch("architect")).body;
  const rec = t.fake.spawns[0];
  let n = 0;
  const run = (name, text, ok) => {
    const id = `tu${(n += 1)}`;
    rec.emit({ type: "tool-start", id, name, summary: "x" });
    rec.emit({ type: "tool-result", id, text, ok });
  };
  const wall = async () => (await t.state()).agents.find((a) => a.id === agent.id).wall;
  const entries = async () => (await t.state()).transcripts?.[agent.id]?.entries ?? [];
  return { agent, rec, run, wall, entries };
}

test("a refused host marks the row by kind and the tool row reads refused", async () => {
  const { run, wall, entries } = await start();
  run("Bash", VIOLATION("example.org"), true);
  const w = await until(async () => (await wall())?.hosts && (await wall()), { what: "the host mark" });
  assert.equal(w.hosts.count, 1);
  assert.equal(w.hosts.latest, "example.org");
  assert.equal(w.writes, undefined);
  const list = await entries();
  assert.equal(list.find((e) => e.kind === "tool").status, "refused");
  assert.match(list.find((e) => e.kind === "wall").text, /The wall refused example\.org\. 1 of 3/);
});

test("a refused write counts apart from hosts, and its tool row stays failed", async () => {
  const { run, wall, entries } = await start();
  run("Bash", VIOLATION("a.example.org"), true);
  run("Bash", WRITE("/etc/hosts"), false);
  const w = await until(async () => (await wall())?.writes && (await wall()), { what: "the write mark" });
  assert.deepEqual([w.hosts.count, w.writes.count, w.writes.latest], [1, 1, "/etc/hosts"]);
  const tools = (await entries()).filter((e) => e.kind === "tool");
  assert.deepEqual(tools.map((e) => e.status), ["refused", "failed"]);
});

test("the same text on a successful result is no mark", async () => {
  const { run, wall } = await start();
  run("Read", WRITE("/etc/hosts"), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await wall(), null);
});

test("the third refused host pauses the agent; Keep refused restarts the count", async () => {
  const { agent, run, wall } = await start();
  for (const h of ["a.example.org", "b.example.org", "c.example.org"]) run("Bash", VIOLATION(h), true);
  const [approval] = await until(async () => {
    const l = ((await t.state()).approvals ?? []).filter((a) => a.agentId === agent.id && a.state === "pending");
    return l.length > 0 && l;
  }, { what: "the wall request" });
  assert.deepEqual(approval.wall, { kind: "host", targets: ["a.example.org", "b.example.org", "c.example.org"] });
  assert.equal((await t.state()).agents.find((a) => a.id === agent.id).state, "waiting_on_user");
  assert.equal((await wall()).hosts.paused, true);
  await send(t.bridge, { path: `/approvals/${approval.id}`, headers: t.headers });
  const res = await t.post(`/approvals/${approval.id}`, { decision: "deny" });
  assert.equal(res.status, 200);
  await until(async () => (await wall()) === null, { what: "the count to restart" });
  assert.notEqual((await t.state()).agents.find((a) => a.id === agent.id).state, "waiting_on_user");
});

test("Grant for this task adds the grant and restarts the count", async () => {
  const { agent, run, wall } = await start();
  for (const h of ["a.example.org", "b.example.org", "c.example.org"]) run("Bash", VIOLATION(h), true);
  const [approval] = await until(async () => {
    const l = ((await t.state()).approvals ?? []).filter((a) => a.agentId === agent.id && a.state === "pending");
    return l.length > 0 && l;
  }, { what: "the wall request" });
  await send(t.bridge, { path: `/approvals/${approval.id}`, headers: t.headers });
  const bad = await t.post(`/approvals/${approval.id}`, { decision: "allow", grants: [{ kind: "host", value: "127.0.0.1" }] });
  assert.equal(bad.status, 400);
  const ok = await t.post(`/approvals/${approval.id}`, { decision: "allow", grants: [{ kind: "host", value: "a.example.org" }] });
  assert.equal(ok.status, 200);
  await until(async () => (await wall()) === null, { what: "the count to restart" });
});

test("an expired pause request restarts the count, so later refusals count again", async () => {
  t = await makeBridge({ policy: { approvalTtlMs: 150 } });
  const { agent } = (await t.dispatch("architect")).body;
  const rec = t.fake.spawns[0];
  let n = 0;
  const run = (h) => {
    const id = `tx${(n += 1)}`;
    rec.emit({ type: "tool-start", id, name: "Bash", summary: "x" });
    rec.emit({ type: "tool-result", id, text: VIOLATION(h), ok: true });
  };
  const wall = async () => (await t.state()).agents.find((a) => a.id === agent.id).wall;
  for (const h of ["a.example.org", "b.example.org", "c.example.org"]) run(h);
  await until(async () => (await wall())?.hosts?.paused === true, { what: "the pause" });
  await until(async () => (await wall()) === null, { what: "the count to restart on expiry" });
  run("d.example.org");
  const w = await until(async () => (await wall())?.hosts && (await wall()), { what: "a fresh count" });
  assert.equal(w.hosts.count, 1);
  assert.equal(w.hosts.paused, false);
});
