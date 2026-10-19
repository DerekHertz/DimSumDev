// den-mvp/13: POST /tickets/approve and /tickets/decline over HTTP, on the shared state fixture.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startBridge } from "./server.mjs";
import { makeStateFixture, FEATURE } from "./bridge-fixture.mjs";
import { origin, send, login, authed } from "./bridge-auth-helpers.mjs";

const CODE = "c0de".repeat(16);
let fx, bridge, headers;
beforeEach(async () => {
  fx = await makeStateFixture({ git: true });
  bridge = await startBridge({ root: fx.root, port: 0, auth: { launchCode: CODE }, denState: path.join(fx.root, ".den-state") });
  headers = authed(bridge, await login(bridge));
});
afterEach(async () => {
  await bridge.close();
  await fx.cleanup();
});
const post = (p, body) => send(bridge, { method: "POST", path: p, headers, body });
const HUMAN = `${FEATURE}/06-human`;
const file = () => readFile(path.join(fx.root, ".scratch", FEATURE, "issues", "06-human.md"), "utf8");

describe("POST /tickets/approve", () => {
  test("moves a ready-for-human ticket to ready-for-agent", async () => {
    const res = await post("/tickets/approve", { ref: HUMAN });
    assert.equal(res.status, 200, res.text);
    assert.match(await file(), /\*\*Status:\*\* ready-for-agent/);
    const state = (await send(bridge, { path: "/state" })).body;
    assert.ok(state.frontier.includes(HUMAN));
  });
  test("a ticket at another status, or an unknown one, is a 409", async () => {
    assert.equal((await post("/tickets/approve", { ref: `${FEATURE}/08-plain` })).status, 409);
    assert.equal((await post("/tickets/approve", { ref: `${FEATURE}/99-nope` })).status, 409);
    assert.equal((await post("/tickets/approve", { ref: HUMAN })).status, 200);
    assert.equal((await post("/tickets/approve", { ref: HUMAN })).status, 409);
  });
  test("a ref that is not a string is a 400", async () => {
    assert.equal((await post("/tickets/approve", {})).status, 400);
  });
  // The router starts only tickets in the work order (ADR 0027), so an approval with no order entry would sit forever.
  const order = () => readFile(path.join(fx.root, ".scratch", "work-order.md"), "utf8");
  test("lists the approved ticket last in the work order, which the file need not have yet", async () => {
    const res = await post("/tickets/approve", { ref: HUMAN });
    assert.equal(res.body.ordered, true, res.text);
    assert.equal(await order(), `## Order\n- ${FEATURE}/06\n`);
  });
  test("keeps the order's other entries and prose, and does not list a ticket twice", async () => {
    const before = `# Work order\n\nprose\n\n## Order\n- ${FEATURE}/02\n\n## Notes\nn\n`;
    await writeFile(path.join(fx.root, ".scratch", "work-order.md"), before);
    await post("/tickets/approve", { ref: HUMAN });
    assert.equal(await order(), `# Work order\n\nprose\n\n## Order\n- ${FEATURE}/02\n- ${FEATURE}/06\n\n## Notes\nn\n`);
  });
  test("a user acts ticket is approved but not listed: an agent cannot do it", async () => {
    const ticket = path.join(fx.root, ".scratch", FEATURE, "issues", "06-human.md");
    await writeFile(ticket, (await file()).replace("**Type:** feature", "**Type:** user acts"));
    const res = await post("/tickets/approve", { ref: HUMAN });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ordered, false);
    await assert.rejects(order(), { code: "ENOENT" });
  });
});

describe("POST /tickets/decline", () => {
  test("closes the ticket and records the note under Comments", async () => {
    const res = await post("/tickets/decline", { ref: HUMAN, note: "out of scope for now" });
    assert.equal(res.status, 200, res.text);
    const text = await file();
    assert.match(text, /\*\*Status:\*\* closed/);
    assert.match(text, /## Comments[\s\S]*out of scope for now/);
  });
  test("a missing or blank note is a 400 and nothing changes", async () => {
    assert.equal((await post("/tickets/decline", { ref: HUMAN })).status, 400);
    assert.equal((await post("/tickets/decline", { ref: HUMAN, note: "  " })).status, 400);
    assert.match(await file(), /ready-for-human/);
  });
  test("a ticket at another status is a 409", async () => {
    assert.equal((await post("/tickets/decline", { ref: `${FEATURE}/08-plain`, note: "no" })).status, 409);
  });
});

describe("the ticket text for Needs you", () => {
  test("a ready-for-human ticket carries its text in /state; one at another status does not", async () => {
    const byRef = new Map((await send(bridge, { path: "/state" })).body.tickets.map((t) => [t.ref, t]));
    assert.match(byRef.get(HUMAN).text, /06: Human/);
    assert.equal(byRef.get(`${FEATURE}/08-plain`).text, undefined);
  });
});
