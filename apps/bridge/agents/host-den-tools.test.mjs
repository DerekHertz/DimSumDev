// den-mvp/38: Bao acts through the bridge. A run given the den connection holds a token; the den script calls
// POST /den-tools/<tool> with it, and the bridge does the work. Board writes go straight through; filing a ticket and
// starting a delivery need the user's own allow of that exact call, and resolving needs a merged pull request.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { makeBridge, until, DISPATCH_REF, FEATURE, send } from "./host-test-helpers.mjs";
import { GOAL_KEY } from "../bridge-fixture.mjs";
import { parseCatalog } from "../library/catalog.mjs";
import { createLibrary } from "../library/library.mjs";

const DEN = { name: "den", title: "The den", purpose: "Bao's hands on the den.", script: "apps/bridge/library/servers/den.mjs", credential: "run", roles: ["orchestrator"],
  tools: { board_resolve: "board", board_comment: "board", board_file: "change", start_delivery: "change", release_propose: "board" } };
const MERGED = 7;
const RELEASE_SHA = "c".repeat(40);
const published = [];
const gitHost = {
  mainSha: async () => RELEASE_SHA, lastTag: async () => "v1.0.0", mergedSince: async () => [{ number: 9, title: "feat: a thing", body: "" }],
  publishRelease: async (r) => { published.push(r); },
  mergeCommit: async ({ number }) => { if (number !== MERGED) throw new Error("the pull request is not merged"); return "a".repeat(40); },
};

let t;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function desk() {
  t = await makeBridge({ runtimeConfig: { send: true }, gitHost, library: createLibrary({ catalog: parseCatalog({ connections: [DEN] }) }) });
  const res = await t.post("/conversations/orchestrator/message", { text: "resolve the merged tickets" });
  assert.ok([200, 201].includes(res.status), res.text);
  const run = await until(() => t.fake.spawns.find((s) => s.args.role === "orchestrator"), { what: "Bao's desk run" });
  const tool = (name, body, token = run.args.runCredential?.token) => send(t.bridge, {
    method: "POST", path: `/den-tools/${name}`, body,
    headers: { Origin: `http://127.0.0.1:${t.bridge.port}`, Authorization: `Bearer ${token}` },
  });
  return { run, tool };
}

describe("Bao's den tools", () => {
  test("the desk run is given the bridge's address and a token of its own", async () => {
    const { run } = await desk();
    assert.match(run.args.runCredential.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(run.args.runCredential.token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(run.args.connections.some((c) => c.name === "den" && c.credential === "run"));
  });

  test("a wrong token, and the run's token after it ended, are refused", async () => {
    const { run, tool } = await desk();
    assert.equal((await tool("board_comment", { ref: DISPATCH_REF, text: "hi" }, "x".repeat(43))).status, 401);
    run.exit({ code: 0 });
    await until(async () => (await tool("board_comment", { ref: DISPATCH_REF, text: "hi" })).status === 401, { what: "the ended run's token to be refused" });
  });

  test("a comment goes straight on the board, as the orchestrator", async () => {
    const { tool } = await desk();
    const res = await tool("board_comment", { ref: DISPATCH_REF, text: "looked at this from the desk" });
    assert.equal(res.status, 200, res.text);
    const file = await readFile(path.join(t.fx.root, ".scratch", FEATURE, "issues", `${DISPATCH_REF.split("/")[1]}.md`), "utf8");
    assert.match(file, /looked at this from the desk/);
  });

  test("resolve refuses an unmerged pull request and resolves on a merged one", async () => {
    const { tool } = await desk();
    const no = await tool("board_resolve", { ref: DISPATCH_REF, pr: 8 });
    assert.equal(no.status, 409);
    assert.match(no.body.error, /not merged/);
    const yes = await tool("board_resolve", { ref: DISPATCH_REF, pr: MERGED });
    assert.equal(yes.status, 200, yes.text);
    assert.match(yes.body.text, /resolved/);
  });

  // den-mvp/55: Bao files a batch on one ask. Each ticket is a drafted one (its own criteria, real Type and Blocked by),
  // and a blocker is an existing ref or the 1-based position of an earlier ticket in the same batch.
  const AC = "\n\n## Acceptance criteria\n\n- [ ] It is done.";
  const BATCH = {
    feature: FEATURE,
    tickets: [
      { title: "Outcome 6 design: target worktrees", text: `## What to decide\n\nWhere worktrees live.${AC}`, priority: "P1", type: "design question", goal: GOAL_KEY },
      { title: "Outcome 6 slice 1: clean start", text: `## What to build\n\nThe adapter.${AC}`, priority: "P1", type: "feature", blockedBy: [1], goal: GOAL_KEY },
      { title: "Outcome 6 slice 2: two roots", text: `## What to build\n\nTwo roots.${AC}`, type: "feature", blockedBy: [1, DISPATCH_REF], slug: "two-roots", goal: GOAL_KEY },
    ],
  };
  async function allow(run, input, requestId = "r-1") {
    run.emit({ type: "permission-request", requestId, tool: "mcp__den__board_file", input });
    const approval = await until(async () => (await t.state()).approvals.find((a) => a.tool === "mcp__den__board_file" && a.state === "pending"), { what: "the ask" });
    await send(t.bridge, { path: `/approvals/${approval.id}`, headers: t.headers });
    assert.equal((await t.post(`/approvals/${approval.id}`, { decision: "allow" })).status, 200);
    return approval;
  }
  const issues = () => readdir(path.join(t.fx.root, ".scratch", FEATURE, "issues"));
  const ticketText = async (ref) => readFile(path.join(t.fx.root, ".scratch", FEATURE, "issues", `${ref.split("/")[1]}.md`), "utf8");

  test("a batch of tickets is filed on one allow of exactly that batch, and the allow is used once", async () => {
    const { run, tool } = await desk();
    assert.equal((await tool("board_file", BATCH)).status, 403, "no allow yet");
    const approval = await allow(run, BATCH);
    assert.match(approval.summary, /^file 3 tickets in /, "the ask's summary says what it files");
    const changed = { ...BATCH, tickets: BATCH.tickets.slice(0, 2) };
    assert.equal((await tool("board_file", changed)).status, 403, "an allow covers only the batch the user saw");
    const res = await tool("board_file", BATCH);
    assert.equal(res.status, 200, res.text);
    const refs = [...res.body.text.matchAll(new RegExp(`${FEATURE}/\\d+-[a-z0-9-]+`, "g"))].map((m) => m[0]);
    assert.equal(refs.length, 3, res.body.text);
    assert.match(refs[0], /\/\d+-outcome-6-design-target-worktrees$/, "the slug comes from the title");
    assert.match(refs[2], /\/\d+-two-roots$/, "an explicit slug is kept");
    const [design, slice1, slice2] = await Promise.all(refs.map(ticketText));
    assert.match(design, /^\*\*Type:\*\* design question$/m);
    assert.match(design, /^\*\*Blocked by:\*\* none$/m);
    assert.match(slice1, new RegExp(`^\\*\\*Blocked by:\\*\\* ${refs[0]}$`, "m"), "a batch position becomes the real ref");
    assert.match(slice2, new RegExp(`^\\*\\*Blocked by:\\*\\* ${refs[0]}, ${DISPATCH_REF}$`, "m"));
    for (const md of [design, slice1, slice2]) {
      assert.match(md, /^\*\*Status:\*\* ready-for-human$/m);
      assert.match(md, new RegExp(`^\\*\\*Goal:\\*\\* ${GOAL_KEY}$`, "m"), "den-mvp/61: the ticket names its goal");
      assert.doesNotMatch(md, /quoted as its author wrote it|The request above is done/);
    }
    assert.equal((await tool("board_file", BATCH)).status, 403, "the allow was used up");
  });

  test("a batch with an unknown blocker, a forward position or a ticket without criteria writes nothing", async () => {
    const { run, tool } = await desk();
    const before = await issues();
    const bad = [
      { ...BATCH, tickets: [{ ...BATCH.tickets[0], blockedBy: [`${FEATURE}/99`] }] },
      { ...BATCH, tickets: [{ ...BATCH.tickets[0], blockedBy: [2] }, BATCH.tickets[1]] },
      { ...BATCH, tickets: [BATCH.tickets[0], { ...BATCH.tickets[1], text: "No criteria." }] },
      { feature: FEATURE, title: "One ticket", text: `Body.${AC}` },
      { feature: FEATURE, tickets: [] },
      { ...BATCH, tickets: [{ ...BATCH.tickets[0], text: `hi \u001b[2J \u202e${AC}` }] },
    ];
    for (const [i, call] of bad.entries()) {
      // F34: a batch the bridge would refuse is denied with the reason when it asks, so the user is never asked for it.
      run.emit({ type: "permission-request", requestId: `r-${i}`, tool: "mcp__den__board_file", input: call });
      const denied = await until(() => run.decisions.find((d) => d.requestId === `r-${i}`), { what: `the answer to r-${i}` });
      assert.equal(denied.allow, false, JSON.stringify(call));
      assert.ok(denied.reason, "the denial says why");
      const res = await tool("board_file", call);
      assert.equal(res.status, 400, JSON.stringify(call));
    }
    assert.equal((await t.state()).approvals.filter((a) => a.tool === "mcp__den__board_file").length, 0, "no bad batch became an ask");
    assert.deepEqual(await issues(), before);
  });

  test("a feature with no issues folder, a body over 8 KB, and a missing or unknown goal are denied at the ask, with the rule", async () => {
    const { run } = await desk();
    const cases = [
      [{ ...BATCH, feature: "no-such-feature" }, /issues folder/],
      [{ ...BATCH, tickets: [{ ...BATCH.tickets[0], text: `${"x".repeat(8193)}${AC}` }] }, /8192 bytes/],
      [{ ...BATCH, tickets: [{ ...BATCH.tickets[0], goal: undefined }] }, new RegExp(`goal must be one of: ${GOAL_KEY}`)],
      [{ ...BATCH, tickets: [{ ...BATCH.tickets[0], goal: "nope" }] }, new RegExp(`goal must be one of: ${GOAL_KEY}`)],
    ];
    for (const [i, [call, rule]] of cases.entries()) {
      run.emit({ type: "permission-request", requestId: `big-${i}`, tool: "mcp__den__board_file", input: call });
      const denied = await until(() => run.decisions.find((d) => d.requestId === `big-${i}`), { what: `the answer to big-${i}` });
      assert.equal(denied.allow, false);
      assert.match(denied.reason, rule);
    }
  });

  test("a ticket body past the 2 KB message cap is filed", async () => {
    const { run, tool } = await desk();
    const call = { feature: FEATURE, tickets: [{ title: "A long design ticket", text: `## What to decide\n\n${"Detail. ".repeat(500)}${AC}`, goal: GOAL_KEY }] };
    await allow(run, call);
    const res = await tool("board_file", call);
    assert.equal(res.status, 200, res.text);
  });

  test("start_delivery is refused without the user's allow", async () => {
    const { tool } = await desk();
    const res = await tool("start_delivery", { ref: DISPATCH_REF });
    assert.equal(res.status, 403);
  });

  test("a role the catalog does not give the den connection is refused", async () => {
    t = await makeBridge({ library: createLibrary({ catalog: parseCatalog({ connections: [DEN] }) }) });
    await t.dispatch("architect");
    const run = await until(() => t.fake.spawns[0], { what: "the run" });
    assert.equal(run.args.runCredential, undefined, "a run without the den connection gets no token");
  });

  test("release_propose drafts without publishing; only the user's Approve tags, at the drafted commit; an agent has no way to", async () => {
    published.length = 0;
    const { tool } = await desk();
    const res = await tool("release_propose", {});
    assert.equal(res.status, 200, res.text);
    const draft = (await send(t.bridge, { method: "GET", path: "/state" })).body.release;
    assert.equal(draft.version, "v1.1.0");
    assert.equal(draft.sha, RELEASE_SHA);
    assert.equal(published.length, 0);
    // no den tool approves, and the approve route refuses the run's own token
    assert.equal((await tool("release_approve", { id: draft.id })).status, 403);
    const own = await send(t.bridge, { method: "POST", path: "/release/approve", body: { id: draft.id }, headers: { Origin: `http://127.0.0.1:${t.bridge.port}`, Authorization: `Bearer ${(await t.fake.spawns[0]).args.runCredential.token}` } });
    assert.notEqual(own.status, 200);
    assert.equal(published.length, 0);
    assert.equal((await t.post("/release/approve", { id: "nope" })).status, 409);
    const ok = await t.post("/release/approve", { id: draft.id });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(published, [{ version: "v1.1.0", sha: RELEASE_SHA, notes: draft.notes }]);
    assert.equal((await send(t.bridge, { method: "GET", path: "/state" })).body.release, null);
  });

  test("Decline drops the draft and publishes nothing", async () => {
    published.length = 0;
    const { tool } = await desk();
    await tool("release_propose", {});
    const { id } = (await send(t.bridge, { method: "GET", path: "/state" })).body.release;
    assert.equal((await t.post("/release/decline", { id })).status, 200);
    assert.equal((await send(t.bridge, { method: "GET", path: "/state" })).body.release, null);
    assert.equal(published.length, 0);
  });
});
