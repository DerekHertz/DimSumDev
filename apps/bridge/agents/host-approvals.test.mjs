// organism-infra/141 (steering approvals, 106-C2): the approval store and routes, at the startBridge seam with the
// fake runtime. ADR 0016 decision 4 (state the UI sees), decision 6 items 4, 5 and 7, and the "Fail-closed rule".
//
// PINNED INTERFACE (additions to the 140 contract in host-test-helpers.mjs; the ADR amendment must agree):
//
//   fake runtime (agents/runtime.mjs)
//     capabilities.approve === true, and each agent's capabilities.approve is true
//     record.emit({ type: "permission-request", requestId, tool, input })     a CellEvent; requestId is the child's opaque key
//     record.process.decide(requestId, { allow, reason? }) -> Promise          records { requestId, allow, reason } in record.decisions
//     record.decisions: array, in call order
//   agents/policy.mjs   APPROVAL_TTL_MS (10 minutes), APPROVAL_CAP_PER_AGENT (20)
//   startBridge policy override (test only, can only lower): approvalTtlMs
//   routes (agents/../routes.mjs registry)
//     { GET  /approvals/:id, auth: "token", mutating: false }   serves the full input; marks the approval "seen"
//     { POST /approvals/:id, auth: "token", mutating: true }    body { decision: "allow" | "deny", note?: string }
//   POST /approvals/:id   200 { approval }; 400 bad body; 404 unknown or malformed id; 409 allow before GET, or already decided or settled
//   GET  /approvals/:id   200 { ...approval, input }  input = the original object with every string value escaped (below); 404 unknown id
//   snapshot `approvals`: [{ id /^a-[0-9a-f]{16}$/, agentId, tool, summary (<= 200 chars), inputLength, truncated, ts, expiresAt,
//                            state: "pending" | "allowed" | "denied" | "expired", note?: string | null, reason?: string }]
//     the child's requestId never appears in the snapshot; an agent with a pending approval is state "waiting_on_user"
//     and returns to "working" once it is decided
//   change type `approval` (full object) with a seq, on request and on every state change
//   escaping rule for text an agent can influence (served input, summary, tool name, tool.summary, note, reason): secret matches are
//     masked (scripts/exposure.mjs hasSecret), bidirectional-override characters and control characters other than \n and \t are
//     never raw in any response: the served input shows them as the visible text \uXXXX (lowercase hex, four digits)
//   sessions.jsonl gains   { ts, event: "decision", agentId, ref, approvalId, decision: "allow" | "deny", route: "POST /approvals/:id", note? }
//   fail closed: expiry, the 20-per-agent cap (oldest first), user stop, child exit and host shutdown each leave the approval
//     non-pending and (while the child lives) answer the runtime with allow:false; the bridge never allows on its own.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FEATURE, until, sleep, makeBridge, openSse, send } from "./host-test-helpers.mjs";
import { ROUTES } from "../routes.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const A_ID_RE = /^a-[0-9a-f]{16}$/;
const BIDI = "‮"; // right-to-left override
const BIDI_ISOLATE = "⁦";
const ESC = "\u001b";
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join(""); // built at runtime so the repo secret scan stays clean; matches the shared secret patterns
const SECOND_REF = `${FEATURE}/31-second-agent`;

const decisions = (rec) => {
  assert.ok(Array.isArray(rec.decisions), "the fake runtime must record decide() calls in record.decisions (141)");
  return rec.decisions;
};
const approvalsOf = async (agentId) => ((await t.state()).approvals ?? []).filter((a) => !agentId || a.agentId === agentId);
const request = (rec, requestId, tool = "Bash", input = { command: "npm test" }) =>
  rec.emit({ type: "permission-request", requestId, tool, input });

// Wait until the agent has `count` approvals matching `pred`; returns them (oldest first).
async function approvalsReach(agentId, count, pred = () => true, what = `${count} approval(s)`) {
  return until(async () => {
    const list = (await approvalsOf(agentId)).filter(pred);
    return list.length >= count && list;
  }, { ms: 2000, what });
}
// One agent, one held request: returns { agent, rec, approval }.
async function hold(input = { command: "npm test" }, { tool = "Bash", requestId = "req-1" } = {}) {
  const { agent } = (await t.dispatch("architect")).body;
  const rec = t.fake.spawns[0];
  request(rec, requestId, tool, input);
  const [approval] = await approvalsReach(agent.id, 1, undefined, "the permission request to appear as an approval");
  return { agent, rec, approval };
}
const get = (id, headers = t.headers) => send(t.bridge, { path: `/approvals/${id}`, headers });
const decide = (id, body, headers = t.headers) => t.post(`/approvals/${id}`, body, headers);

describe("the registry and the policy constants", () => {
  test("GET and POST /approvals/:id are token-gated rows, the POST mutating", () => {
    const g = ROUTES.find((r) => r.method === "GET" && r.path === "/approvals/:id");
    const p = ROUTES.find((r) => r.method === "POST" && r.path === "/approvals/:id");
    assert.deepEqual([g?.auth, g?.mutating], ["token", false]);
    assert.deepEqual([p?.auth, p?.mutating], ["token", true]);
  });

  test("policy.mjs fixes the 10-minute expiry and the 20-per-agent cap", async () => {
    const policy = await import("./policy.mjs");
    assert.equal(policy.APPROVAL_TTL_MS, 10 * 60 * 1000);
    assert.equal(policy.APPROVAL_CAP_PER_AGENT, 20);
  });
});

describe("holding a permission request (criterion 1)", () => {
  test("a permission request becomes a pending approval bound to its agent, and the agent waits on the user", async () => {
    t = await makeBridge();
    const { agent, approval } = await hold({ command: "npm test" });
    assert.match(approval.id, A_ID_RE);
    assert.equal(approval.agentId, agent.id);
    assert.equal(approval.tool, "Bash");
    assert.equal(approval.summary, "npm test");
    assert.equal(approval.state, "pending");
    assert.equal(approval.truncated, false);
    assert.ok(approval.inputLength >= "npm test".length);
    assert.ok(!Number.isNaN(Date.parse(approval.ts)));
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.ts), 10 * 60 * 1000, "default expiry is 10 minutes");
    const a = await until(async () => {
      const x = await t.agent(agent.id);
      return x?.state === "waiting_on_user" && x;
    }, { what: "agent waiting_on_user" });
    assert.equal(a.capabilities.approve, true);
    assert.deepEqual(decisions(t.fake.spawns[0]), [], "nothing is answered while the user has not decided");
  });

  test("the child's own request id never reaches the snapshot", async () => {
    t = await makeBridge();
    const { rec } = await hold({ command: "ls" }, { requestId: "child-secret-key-77" });
    const raw = (await send(t.bridge, { path: "/state" })).text;
    assert.ok(!raw.includes("child-secret-key-77"));
    assert.equal(rec.decisions?.length ?? 0, 0);
  });

  test("allow: after the full input was served, the runtime gets allow for that exact request and the agent resumes", async () => {
    t = await makeBridge();
    const { agent, rec, approval } = await hold({ command: "npm test" }, { requestId: "req-allow" });
    assert.equal((await get(approval.id)).status, 200);
    const res = await decide(approval.id, { decision: "allow" });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.approval.state, "allowed");
    const d = decisions(rec);
    assert.equal(d.length, 1);
    assert.equal(d[0].requestId, "req-allow");
    assert.equal(d[0].allow, true);
    assert.equal((await approvalsOf(agent.id))[0].state, "allowed");
    await until(async () => (await t.agent(agent.id))?.state === "working", { what: "agent back to working" });
  });

  test("deny needs no prior GET: the runtime gets allow:false for that request and the note is kept", async () => {
    t = await makeBridge();
    const { agent, rec, approval } = await hold({ command: "rm -rf build" }, { requestId: "req-deny" });
    const res = await decide(approval.id, { decision: "deny", note: "not that one" });
    assert.equal(res.status, 200, res.text);
    const d = decisions(rec);
    assert.deepEqual([d.length, d[0].requestId, d[0].allow], [1, "req-deny", false]);
    const stored = (await approvalsOf(agent.id))[0];
    assert.equal(stored.state, "denied");
    assert.equal(stored.note, "not that one");
    await until(async () => (await t.agent(agent.id))?.state === "working", { what: "agent back to working" });
  });

  test("a second decision on the same id is 409 and reaches the runtime once", async () => {
    t = await makeBridge();
    const { rec, approval } = await hold();
    await get(approval.id);
    assert.equal((await decide(approval.id, { decision: "deny" })).status, 200);
    assert.equal((await decide(approval.id, { decision: "allow" })).status, 409);
    assert.equal((await decide(approval.id, { decision: "deny" })).status, 409);
    assert.equal(decisions(rec).length, 1);
  });

  test("two concurrent decisions on one approval: exactly one wins, the runtime is answered once", async () => {
    t = await makeBridge();
    const { rec, approval } = await hold();
    await get(approval.id);
    const results = await Promise.all([decide(approval.id, { decision: "allow" }), decide(approval.id, { decision: "allow" })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(decisions(rec).length, 1);
  });

  test("the SSE stream carries an `approval` change with a seq when it is requested and again when it is decided", async () => {
    t = await makeBridge();
    const sse = openSse(t.bridge);
    await sse.opened;
    try {
      const first = await sse.next((f) => f.event === "snapshot");
      assert.deepEqual(first.data.approvals, [], "a fresh snapshot carries an empty approvals array");
      const { agent } = (await t.dispatch("architect")).body;
      request(t.fake.spawns[0], "req-sse");
      const asked = await sse.next((f) => f.event === "change" && f.data.type === "approval" && f.data.approval?.state === "pending");
      assert.equal(asked.data.approval.agentId, agent.id);
      assert.equal(typeof asked.data.seq, "number");
      assert.equal((await decide(asked.data.approval.id, { decision: "deny" })).status, 200);
      const done = await sse.next((f) => f.event === "change" && f.data.type === "approval" && f.data.approval?.state === "denied");
      assert.equal(done.data.approval.id, asked.data.approval.id);
      assert.ok(done.data.seq > asked.data.seq);
    } finally {
      sse.close();
    }
  });
});

describe("bad ids and bad bodies", () => {
  test("an unknown or malformed approval id is 404 on both routes (with a token)", async () => {
    t = await makeBridge();
    await hold();
    for (const id of ["a-0000000000000000", "nope", "a-zz", "..%2F..%2Fetc", "c-0123456789abcdef"]) {
      assert.equal((await get(id)).status, 404, `GET ${id}`);
      assert.equal((await decide(id, { decision: "deny" })).status, 404, `POST ${id}`);
    }
  });

  test("an unauthenticated GET is 401 and identical for a real and a bogus id", async () => {
    t = await makeBridge();
    const { approval } = await hold();
    const noTok = { Origin: t.headers.Origin };
    const real = await get(approval.id, noTok);
    const bogus = await get("a-0000000000000000", noTok);
    assert.equal(real.status, 401);
    assert.equal(bogus.status, 401);
    assert.deepEqual(real.body, bogus.body);
    assert.equal((await get(approval.id, { ...t.headers, Authorization: "Bearer nope" })).status, 401);
  });

  test("a body without a valid decision is 400 and nothing reaches the runtime", async () => {
    t = await makeBridge();
    const { rec, approval } = await hold();
    await get(approval.id);
    for (const body of [{}, { decision: "maybe" }, { decision: "ALLOW" }, { decision: true }, { decision: ["allow"] }, { decision: "allow", note: 5 }, { decision: "deny", note: { a: 1 } }]) {
      const res = await decide(approval.id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(decisions(rec), []);
    assert.equal((await approvalsOf())[0].state, "pending");
  });
});

describe("allow only after the full input was served (criterion 2)", () => {
  test("allow without a prior GET is 409, reaches nothing, and the approval stays pending", async () => {
    t = await makeBridge();
    const { agent, rec, approval } = await hold();
    const res = await decide(approval.id, { decision: "allow" });
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(decisions(rec), []);
    assert.equal((await approvalsOf(agent.id))[0].state, "pending");
    assert.equal((await get(approval.id)).status, 200);
    assert.equal((await decide(approval.id, { decision: "allow" })).status, 200, "the same allow succeeds once the input was served");
  });

  test("a GET of one approval does not unlock another", async () => {
    t = await makeBridge();
    const { agent, rec, approval } = await hold({ command: "first" }, { requestId: "req-a" });
    request(rec, "req-b", "Bash", { command: "second" });
    const [, second] = await approvalsReach(agent.id, 2);
    await get(approval.id);
    assert.equal((await decide(second.id, { decision: "allow" })).status, 409);
    assert.deepEqual(decisions(rec), []);
  });

  test("a GET refused for lack of a token does not unlock allow", async () => {
    t = await makeBridge();
    const { rec, approval } = await hold();
    assert.equal((await get(approval.id, { Origin: t.headers.Origin })).status, 401);
    assert.equal((await decide(approval.id, { decision: "allow" })).status, 409);
    assert.deepEqual(decisions(rec), []);
  });

  test("the served input is the whole input, even when the summary was cut", async () => {
    t = await makeBridge();
    const command = `echo ${"x".repeat(5000)} && echo TAIL-MARKER`;
    const { approval } = await hold({ command, timeout: 1000 });
    assert.ok(approval.summary.length <= 200, `summary is ${approval.summary.length} chars`);
    assert.ok(!approval.summary.includes("TAIL-MARKER"), "the cut summary hides the tail");
    assert.equal(approval.truncated, true);
    assert.ok(approval.inputLength >= command.length);
    const res = await get(approval.id);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.equal(res.body.input.command, command, "nothing truncated in the served input");
    assert.equal(res.body.input.timeout, 1000);
    assert.equal(res.body.id, approval.id);
    assert.equal(res.body.tool, "Bash");
  });
});

describe("fail closed: expiry, the per-agent cap, user stop, child exit and shutdown deny (criterion 3)", () => {
  test("expiry: an undecided approval is answered deny and can no longer be decided", async () => {
    t = await makeBridge({ policy: { approvalTtlMs: 150 } });
    const { agent, rec, approval } = await hold({ command: "sleep 1" }, { requestId: "req-exp" });
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.ts), 150);
    await until(async () => (await approvalsOf(agent.id))[0].state === "expired", { ms: 3000, what: "approval to expire" });
    const d = decisions(rec);
    assert.deepEqual([d.length, d[0].requestId, d[0].allow], [1, "req-exp", false]);
    assert.equal((await decide(approval.id, { decision: "deny" })).status, 409);
    await get(approval.id);
    assert.equal((await decide(approval.id, { decision: "allow" })).status, 409, "an expired approval is never allowed");
    assert.equal(decisions(rec).length, 1);
    await until(async () => (await t.agent(agent.id))?.state === "working", { what: "agent no longer waiting once nothing is pending" });
  });

  test("a decision made before expiry is not answered a second time when the timer fires", async () => {
    t = await makeBridge({ policy: { approvalTtlMs: 200 } });
    const { rec, approval } = await hold();
    assert.equal((await decide(approval.id, { decision: "deny" })).status, 200);
    await sleep(400);
    assert.equal(decisions(rec).length, 1);
    assert.equal((await approvalsOf())[0].state, "denied");
  });

  test("cap: the 21st pending request expires the oldest (answered deny); other agents are untouched", async () => {
    t = await makeBridge();
    const { agent, rec } = await hold({ command: "c0" }, { requestId: "req-0" });
    const other = (await t.bridge.host.start({ ref: SECOND_REF, role: "sre" })).agent;
    const otherRec = t.fake.spawns[1];
    request(otherRec, "other-0", "Bash", { command: "other" });
    await approvalsReach(other.id, 1);
    for (let i = 1; i <= 20; i += 1) request(rec, `req-${i}`, "Bash", { command: `c${i}` });
    await until(() => decisions(rec).some((d) => d.requestId === "req-0"), { ms: 3000, what: "the oldest request to be answered" });
    const list = await approvalsReach(agent.id, 21, undefined, "21 approvals recorded");
    const pending = list.filter((a) => a.state === "pending");
    assert.equal(pending.length, 20, "at most 20 pending per agent");
    assert.equal(list.find((a) => a.summary === "c0").state, "expired");
    assert.deepEqual(decisions(rec).filter((d) => d.requestId === "req-0").map((d) => d.allow), [false]);
    assert.equal(decisions(rec).filter((d) => d.allow).length, 0, "the cap never allows");
    assert.equal(pending.some((a) => a.summary === "c20"), true, "the newest is kept");
    assert.equal((await approvalsOf(other.id))[0].state, "pending");
    assert.deepEqual(decisions(otherRec), []);
  });

  test("stop: a user kill leaves nothing pending and never allows", async () => {
    t = await makeBridge();
    const { agent, rec, approval } = await hold({ command: "make deploy" });
    assert.equal((await t.post(`/agents/${agent.id}/stop`, {})).status, 202);
    await until(async () => (await t.agent(agent.id))?.state === "terminated", { what: "terminated" });
    assert.notEqual((await approvalsOf(agent.id))[0].state, "pending");
    assert.equal(decisions(rec).some((d) => d.allow), false);
    await get(approval.id);
    assert.equal((await decide(approval.id, { decision: "allow" })).status, 409);
    assert.equal(decisions(rec).some((d) => d.allow), false);
  });

  test("child exit: an approval whose process died is settled and cannot be allowed", async () => {
    t = await makeBridge();
    const { agent, rec, approval } = await hold({ command: "make deploy" });
    rec.exit({ code: 1 });
    await until(async () => (await t.agent(agent.id))?.state === "failed", { what: "failed" });
    assert.notEqual((await approvalsOf(agent.id))[0].state, "pending");
    await get(approval.id);
    assert.equal((await decide(approval.id, { decision: "allow" })).status, 409);
    assert.equal(decisions(rec).some((d) => d.allow), false);
  });

  test("shutdown: every pending approval of every live agent is answered deny and none is left pending", async () => {
    t = await makeBridge();
    const { agent, rec } = await hold({ command: "c0" }, { requestId: "req-0" });
    request(rec, "req-1", "Bash", { command: "c1" });
    const other = (await t.bridge.host.start({ ref: SECOND_REF, role: "sre" })).agent;
    const otherRec = t.fake.spawns[1];
    request(otherRec, "other-0", "Bash", { command: "other" });
    await approvalsReach(agent.id, 2);
    await approvalsReach(other.id, 1);
    await t.bridge.host.shutdown();
    for (const [r, ids] of [[rec, ["req-0", "req-1"]], [otherRec, ["other-0"]]]) {
      for (const id of ids) {
        const mine = decisions(r).filter((d) => d.requestId === id);
        assert.deepEqual(mine.map((d) => d.allow), [false], `${id} answered deny exactly once`);
      }
    }
    for (const a of await approvalsOf()) assert.notEqual(a.state, "pending", `${a.id} must not stay pending`);
  });
});

describe("masking and escaping in everything an agent can influence (criterion 4)", () => {
  const rawBidi = (text) => /[‪-‮⁦-⁩‎‏]/.test(text);
  const rawControl = (text) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text);
  const hasUnicodeEscape = (value, hex) => typeof value === "string" && value.toLowerCase().includes(`\\u${hex}`);

  test("served input: a secret is masked wherever it nests, and the real value is never sent", async () => {
    t = await makeBridge();
    const { approval } = await hold({ command: `aws s3 ls --key ${AWS_KEY}`, env: { AWS_KEY, nested: [{ k: AWS_KEY }] } });
    const res = await get(approval.id);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes(AWS_KEY), "GET /approvals/:id must not serve the secret");
    assert.ok(!JSON.stringify(approval).includes(AWS_KEY), "the snapshot approval must not carry it");
    assert.ok(!(await send(t.bridge, { path: "/state" })).text.includes(AWS_KEY));
    assert.equal(typeof res.body.input.command, "string", "the structure of the input survives masking");
  });

  test("served input: bidi and control characters are never raw, and show as visible \\uXXXX text", async () => {
    t = await makeBridge();
    const { approval } = await hold({ command: `ls${BIDI}txt.exe${BIDI_ISOLATE}`, path: `a${ESC}[31mred\nline2\tend`, list: [`x${BIDI}y`] });
    const res = await get(approval.id);
    assert.equal(res.status, 200);
    assert.ok(!rawBidi(res.text), "no raw bidirectional override in the response body");
    assert.ok(!rawControl(res.text), "no raw control character in the response body");
    assert.ok(hasUnicodeEscape(res.body.input.command, "202e"), res.body.input.command);
    assert.ok(hasUnicodeEscape(res.body.input.command, "2066"));
    assert.ok(hasUnicodeEscape(res.body.input.path, "001b"), res.body.input.path);
    assert.ok(res.body.input.path.includes("\n") && res.body.input.path.includes("\t"), "newline and tab stay readable");
    assert.ok(hasUnicodeEscape(res.body.input.list[0], "202e"), "arrays are escaped too");
  });

  test("approval summary and tool name: no raw bidi or control character, no secret, in /state or the SSE stream", async () => {
    t = await makeBridge();
    const sse = openSse(t.bridge);
    await sse.opened;
    try {
      const { agent } = (await t.dispatch("architect")).body;
      request(t.fake.spawns[0], "req-x", `Ba${BIDI}sh`, { command: `echo ${AWS_KEY} ${BIDI}${ESC}` });
      await approvalsReach(agent.id, 1);
      await sse.next((f) => f.event === "change" && f.data.type === "approval");
      const state = (await send(t.bridge, { path: "/state" })).text;
      const stream = JSON.stringify(sse.frames);
      for (const [where, text] of [["/state", state], ["sse", stream]]) {
        assert.ok(!text.includes(AWS_KEY), `${where} leaks the secret`);
        assert.ok(!rawBidi(text), `${where} carries a raw bidi character`);
        assert.ok(!rawControl(text.replace(/\n/g, "")), `${where} carries a raw control character`);
      }
      assert.ok((await approvalsOf())[0].summary.length <= 200);
    } finally {
      sse.close();
    }
  });

  test("tool.summary and tool name of a running agent: secrets masked and bidi never raw, in /state and the SSE stream", async () => {
    t = await makeBridge();
    const sse = openSse(t.bridge);
    await sse.opened;
    try {
      const { agent } = (await t.dispatch("architect")).body;
      t.fake.spawns[0].emit({ type: "tool-start", name: `Ba${BIDI}sh`, summary: `curl -H "Authorization: ${"Bear" + "er"} abcdefghijklmnop1234" ${AWS_KEY} ${BIDI}evil` });
      const seen = await until(async () => (await t.agent(agent.id))?.tool, { what: "tool-start in the snapshot" });
      await sse.next((f) => f.event === "change" && f.data.type === "agent" && f.data.agent?.tool);
      const state = (await send(t.bridge, { path: "/state" })).text;
      const stream = JSON.stringify(sse.frames);
      for (const [where, text] of [["/state", state], ["sse", stream]]) {
        assert.ok(!text.includes(AWS_KEY), `${where} leaks the secret`);
        assert.ok(!text.includes("abcdefghijklmnop1234"), `${where} leaks the bearer token`);
        assert.ok(!rawBidi(text), `${where} carries a raw bidi character`);
      }
      assert.ok(!rawBidi(seen.name + seen.summary));
    } finally {
      sse.close();
    }
  });

  test("notes: a secret or bidi text in a decision note is masked in the snapshot, the audit line and what the child is told", async () => {
    t = await makeBridge();
    const note = `use ${AWS_KEY} ${BIDI}instead${ESC}`;
    const { agent, rec, approval } = await hold({ command: "ls" });
    const res = await decide(approval.id, { decision: "deny", note });
    assert.equal(res.status, 200, res.text);
    const state = (await send(t.bridge, { path: "/state" })).text;
    const audit = await readFile(t.sessionsFile, "utf8");
    const told = JSON.stringify(decisions(rec));
    for (const [where, text] of [["/state", state], ["sessions.jsonl", audit], ["the child", told], ["the response", res.text]]) {
      assert.ok(!text.includes(AWS_KEY), `${where} leaks the secret from the note`);
      assert.ok(!rawBidi(text), `${where} carries a raw bidi character from the note`);
      assert.ok(!rawControl(text.replace(/\n/g, "")), `${where} carries a raw control character from the note`);
    }
    assert.equal(typeof (await approvalsOf(agent.id))[0].note, "string", "a note is still kept, masked");
  });
});

describe("hostile or undecodable requests are denied, never held (ADR 0016 6.5)", () => {
  test("a malformed request with a recoverable request id is answered deny and never becomes an approval", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    const bad = [
      ["bad-empty-tool", { tool: "", input: { command: "ls" } }],
      ["bad-number-tool", { tool: 5, input: { command: "ls" } }],
      ["bad-array-input", { tool: "Bash", input: ["ls"] }],
      ["bad-string-input", { tool: "Bash", input: "ls" }],
      ["bad-null-input", { tool: "Bash", input: null }],
      ["bad-no-input", { tool: "Bash" }],
    ];
    for (const [requestId, rest] of bad) rec.emit({ type: "permission-request", requestId, ...rest });
    await until(() => decisions(rec).length >= bad.length, { ms: 3000, what: "every malformed request to be answered" });
    assert.deepEqual(decisions(rec).map((d) => d.requestId).sort(), bad.map(([id]) => id).sort());
    assert.ok(decisions(rec).every((d) => d.allow === false));
    assert.deepEqual(await approvalsOf(agent.id), []);
  });

  test("a request with no usable request id is dropped: no approval, no answer, and the agent keeps running", async () => {
    t = await makeBridge();
    const { agent } = (await t.dispatch("architect")).body;
    const rec = t.fake.spawns[0];
    for (const requestId of [undefined, null, 7, { a: 1 }, "r".repeat(129)]) rec.emit({ type: "permission-request", requestId, tool: "Bash", input: { command: "ls" } });
    rec.emit({ type: "tool-start", name: "Read", summary: "marker.md" });
    await until(async () => (await t.agent(agent.id))?.tool?.summary === "marker.md", { what: "the stream to carry on past the bad requests" });
    assert.deepEqual(await approvalsOf(agent.id), []);
    assert.equal(decisions(rec).some((d) => d.allow), false);
    assert.equal((await t.agent(agent.id)).state, "working");
  });

  test("a repeated request id from the same child is answered deny and creates no second approval", async () => {
    t = await makeBridge();
    const { agent, rec, approval } = await hold({ command: "npm test" }, { requestId: "dup-1" });
    request(rec, "dup-1", "Bash", { command: "rm -rf /" });
    await until(() => decisions(rec).some((d) => d.requestId === "dup-1" && d.allow === false), { ms: 3000, what: "the duplicate to be denied" });
    const list = await approvalsOf(agent.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, approval.id);
    assert.equal(list[0].state, "pending", "the original is still held");
    assert.equal(list[0].summary, "npm test");
  });
});

describe("the audit line (ADR 0016 decision 4, registry persistence)", () => {
  test("an explicit decision appends one decision line with the approval id and the route", async () => {
    t = await makeBridge();
    const { agent, approval } = await hold({ command: "ls" });
    await get(approval.id);
    assert.equal((await decide(approval.id, { decision: "allow", note: "ok" })).status, 200);
    const lines = (await readFile(t.sessionsFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const line = lines.filter((l) => l.event === "decision");
    assert.equal(line.length, 1);
    assert.equal(line[0].agentId, agent.id);
    assert.equal(line[0].ref, agent.ref);
    assert.equal(line[0].approvalId, approval.id);
    assert.equal(line[0].decision, "allow");
    assert.equal(line[0].route, "POST /approvals/:id");
    assert.ok(!Number.isNaN(Date.parse(line[0].ts)));
  });

  test("a refused allow (409 before GET) writes no decision line", async () => {
    t = await makeBridge();
    const { approval } = await hold();
    assert.equal((await decide(approval.id, { decision: "allow" })).status, 409);
    const text = await readFile(t.sessionsFile, "utf8");
    assert.ok(!text.split("\n").filter(Boolean).some((l) => JSON.parse(l).event === "decision"));
  });
});
