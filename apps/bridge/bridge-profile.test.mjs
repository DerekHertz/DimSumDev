// trust-ladder/01: the lean/full Profile over HTTP. Seam: startBridge (GET /state, POST /profile, POST /agents).
//
// Criterion -> test:
//   1 the bridge reports the profile and the values it yields ... "GET /state reports the profile ..."
//   2 a flip changes a new run's allowance, no restart; default full
//       ........................................................ "the default is full ...", "a flip changes ..." (host reads the profile live),
//                                                                 "the route is a token-gated steering row", "a bad request changes nothing"
//   3 limits.json classes identical in both profiles ........... "the wall reads the same in both profiles"
//   5 CONTEXT.md term and ADR ................................... profileDocs below
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROUTES } from "./routes.mjs";
import { makeBridge, DISPATCH_REF, FEATURE } from "./agents/host-test-helpers.mjs";
import { createProfile, PROFILES } from "./agents/profile.mjs";
import { origin, send } from "./bridge-auth-helpers.mjs";

let t;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const flip = (name, headers) => t.post("/profile", name === undefined ? {} : { name }, headers);
const limitsHash = async () => createHash("sha256").update(await readFile(new URL("./agents/limits.json", import.meta.url))).digest("hex");

describe("the profile over HTTP", () => {
  test("the route is a token-gated steering row, not open to the service token", () => {
    const row = ROUTES.find((r) => r.method === "POST" && r.path === "/profile");
    assert.ok(row, "no POST /profile row");
    assert.equal(row.auth, "token");
    assert.equal(row.mutating, true);
    assert.ok(!row.service);
  });

  test("the default is full, and GET /state reports the profile with the values it yields", async () => {
    t = await makeBridge();
    const { profile } = await t.state();
    assert.equal(profile.name, "full");
    assert.deepEqual(profile.values, PROFILES.full);
    assert.ok(profile.values.verifiers.riskPath > 1);
    assert.equal(profile.values.leafTier, PROFILES.full.leafTier);
  });

  test("flipping to lean answers 200 with the profile, and the state then reports lean's values", async () => {
    t = await makeBridge();
    const res = await flip("lean");
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.profile, { name: "lean", values: PROFILES.lean });
    const { profile } = await t.state();
    assert.equal(profile.name, "lean");
    assert.equal(profile.values.leafTier, "haiku");
    assert.deepEqual(profile.values.verifiers, { standard: 1, riskPath: 1, ui: 1 });
    assert.equal(profile.values.splitAboveTokens, 150000);
    assert.equal((await flip("full")).status, 200);
    assert.equal((await t.state()).profile.name, "full");
  });

  test("the choice survives a restart on the same state folder", async () => {
    t = await makeBridge();
    await flip("lean");
    const again = await makeBridge({ root: t.fx.root });
    try {
      assert.equal((await again.state()).profile.name, "lean");
    } finally {
      await again.bridge.close();
    }
  });

  test("a flip changes the profile the state reports, with no restart", async (ctx) => {
    const dir = await mkdtemp(path.join(tmpdir(), "den-profile-"));
    ctx.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "profile.json");
    const profile = createProfile({ file });
    t = await makeBridge({ extra: { profile } });
    assert.equal((await t.state()).profile.name, "full");
    assert.equal((await flip("lean")).status, 200);
    assert.deepEqual((await t.state()).profile, { name: "lean", values: PROFILES.lean });
    await flip("full");
    assert.equal((await t.state()).profile.name, "full");
  });

  test("a bad request changes nothing: no name, a non-string, an unknown profile, no token", async () => {
    t = await makeBridge();
    await flip("lean");
    assert.equal((await flip(undefined)).status, 400);
    assert.equal((await flip(7)).status, 400);
    assert.equal((await flip("turbo")).status, 400);
    assert.equal((await send(t.bridge, { method: "POST", path: "/profile", headers: { Origin: origin(t.bridge) }, body: { name: "full" } })).status, 401);
    assert.equal((await t.state()).profile.name, "lean");
  });

  test("nothing flips the profile by itself: a full usage reading leaves it as it was", async () => {
    t = await makeBridge({ extra: { usage: () => ({ fiveHour: 100, weekly: 100, sampledAt: new Date().toISOString() }) } });
    assert.equal((await t.state()).usage.fiveHour, 100);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await t.state()).profile.name, "full");
  });

  test("the wall reads the same in both profiles: limits.json is untouched and the snapshot's wall does not change", async () => {
    t = await makeBridge();
    const before = { limits: await limitsHash(), wall: (await t.state()).wall };
    await flip("lean");
    const lean = { limits: await limitsHash(), wall: (await t.state()).wall };
    await flip("full");
    const full = { limits: await limitsHash(), wall: (await t.state()).wall };
    assert.deepEqual(lean, before);
    assert.deepEqual(full, before);
  });
});

describe("profileDocs", () => {
  const repo = new URL("../../", import.meta.url);
  test("CONTEXT.md defines Profile without implementation detail", async () => {
    const text = await readFile(new URL("CONTEXT.md", repo), "utf8");
    const entry = text.split("\n\n").find((block) => block.startsWith("**Profile**:"));
    assert.ok(entry, "no **Profile**: term");
    assert.match(entry, /lean/);
    assert.match(entry, /full/);
    assert.ok(!/\.mjs|\.json|POST|\/profile/.test(entry), "the glossary entry carries no implementation detail");
  });

  test("an ADR records the profile switch", async () => {
    const dir = new URL("docs/adr/", repo);
    const files = (await readdir(dir)).filter((f) => /^\d{4}-.*profile.*\.md$/.test(f));
    assert.equal(files.length, 1, `ADR files: ${files}`);
    const text = await readFile(new URL(files[0], dir), "utf8");
    for (const needle of [/default.*full/is, /by hand|hand-flipped|manual/i, /automatic/i, /usage-watch/, /limits\.json|wall/i]) assert.match(text, needle);
  });
});
