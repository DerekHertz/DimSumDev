// trust-ladder/01: the lean/full Profile, a pure table plus a small file-backed store. Seam: createProfile's public view.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProfile, PROFILES, DEFAULT_PROFILE } from "./profile.mjs";

let dir, file;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "den-profile-"));
  file = path.join(dir, "profile.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("the profile table", () => {
  test("lean keeps today's values: Haiku leaves, 1 verifier everywhere, split above 150k", () => {
    const lean = PROFILES.lean;
    assert.equal(lean.maxConcurrent, undefined, "portable-den/10: no worker count in the table");
    assert.equal(lean.leafTier, "haiku");
    assert.deepEqual(lean.verifiers, { standard: 1, riskPath: 1, ui: 1 });
    assert.equal(lean.splitAboveTokens, 150000);
  });

  test("full runs more than one verifier on risk-path and UI tickets", () => {
    const full = PROFILES.full;
    assert.equal(full.maxConcurrent, undefined);
    assert.ok(full.verifiers.riskPath > 1 && full.verifiers.ui > 1);
    assert.equal(full.verifiers.standard, 1);
    assert.ok(full.verifierLoopCap >= PROFILES.lean.verifierLoopCap);
  });

  test("the default is full", () => {
    assert.equal(DEFAULT_PROFILE, "full");
  });

  test("no profile value names a resource-group class: the wall is not part of the table", () => {
    const limits = JSON.parse(readFileSync(new URL("./limits.json", import.meta.url), "utf8"));
    const keys = JSON.stringify(PROFILES);
    for (const name of ["memoryMiB", "cpuPercent", "tasks", "jobMiB", "outputMiB", ...Object.keys(limits.classes)]) assert.ok(!keys.includes(name), `${name} in the profile table`);
  });
});

describe("the profile store", () => {
  test("with no file the profile is full, and its view carries the values", () => {
    const p = createProfile({ file });
    assert.equal(p.name(), "full");
    assert.deepEqual(p.view(), { name: "full", values: PROFILES.full });
    assert.deepEqual(p.values(), PROFILES.full);
  });

  test("a corrupt or unknown file falls back to full", async () => {
    await writeFile(file, "{not json");
    assert.equal(createProfile({ file }).name(), "full");
    await writeFile(file, JSON.stringify({ profile: "turbo" }));
    assert.equal(createProfile({ file }).name(), "full");
  });

  test("set changes what values() answers at once, and a new store over the same file reads it back", async () => {
    const p = createProfile({ file });
    assert.deepEqual(await p.set("lean"), { name: "lean", values: PROFILES.lean });
    assert.deepEqual(p.values(), PROFILES.lean);
    assert.equal(createProfile({ file }).name(), "lean");
    await p.set("full");
    assert.equal(createProfile({ file }).name(), "full");
  });

  test("set refuses a name that is not lean or full and changes nothing", async () => {
    const p = createProfile({ file });
    await p.set("lean");
    for (const bad of ["turbo", "", undefined, 7, null, "__proto__"]) await assert.rejects(() => p.set(bad), /lean or full/);
    assert.equal(p.name(), "lean");
  });

  test("the write is atomic: the file holds whole JSON and no temp file is left behind", async () => {
    const p = createProfile({ file });
    await Promise.all([p.set("lean"), p.set("full"), p.set("lean")]);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { profile: "lean" });
    assert.deepEqual(await readdir(dir), ["profile.json"]);
  });

  test("a table can be injected, so a test can give the two profiles different leaf tiers", async () => {
    const p = createProfile({ file, table: { lean: { ...PROFILES.lean, leafTier: "a" }, full: { ...PROFILES.full, leafTier: "b" } } });
    assert.equal(p.values().leafTier, "b");
    await p.set("lean");
    assert.equal(p.values().leafTier, "a");
  });
});
