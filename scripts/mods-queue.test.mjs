// organism-infra/212: the queue band mod, packaged like mods/north-star.
//
// Seams pinned by qa:
//   mods/queue/hooks/render.mjs   export function renderBand(queue) -> string
//     queue is the object scripts/queue.mjs --json returns ({ inFlight, ready, waitingOnUser, blocked, proposed }).
//     Pure and dependency-free (a mod runs with no Node). The result is one or two lines joined by "\n"
//     (no ANSI needed: the mod draws it in a dim Text), each at most 120 characters:
//       line 1  in flight: for each inFlight row, the ticket number (no leading zeros), its title and its agent.
//       line 2  next: the ticket numbers and titles of the first 3 `proposed` rows; when `proposed` is
//               empty, the first 3 `ready` rows instead.
//     A queue with nothing to show, or anything that is not a queue (null, undefined, a string, an object
//     of the wrong shape), renders "" and never throws.
//   mods/queue/.claude-plugin/plugin.json, mods/queue/hooks/hooks.json ({ "modules": [..] })
//   .claude-plugin/marketplace.json lists "queue" at a relative source, beside sleep-guard and north-star
//   mods/queue/hooks/register.tsx shells out to scripts/queue.mjs --json on session.start and turn.complete.
//
// Criterion map: AC4 band shows in flight plus next 3 proposed (or top 3 ready) -> "AC4 ..."
//                AC4 renders nothing when the script fails                       -> "AC4 ..." (renderBand of non-queues,
//                    plus the register.tsx source check; the live fail-quiet path is human-verified)
//                Mod drawing in a live terminal claude session                   -> human-verified
//                The /queue command file under .claude/commands/ (gated patch)    -> human-verified
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../apps/board/board-fixture.mjs";
import { boardRoot, ticket } from "./queue-fixture.mjs";

const MOD = path.join(REPO_ROOT, "mods", "queue");
const RENDER = path.join(MOD, "hooks", "render.mjs");
const renderBand = async (q) => (await import(RENDER)).renderBand(q);
const json = (...p) => JSON.parse(readFileSync(path.join(REPO_ROOT, ...p), "utf8"));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const lines = (s) => strip(s).split("\n").filter((l) => l.trim());

const row = (num, title, extra = {}) => ({ ref: `alpha/${num}-slug`, title, priority: 1, ...extra });
const queue = (over = {}) => ({ inFlight: [], ready: [], waitingOnUser: [], blocked: [], proposed: [], ...over });

test("AC4 the band shows each in-flight ticket with its number, title and agent", async () => {
  const text = strip(await renderBand(queue({ inFlight: [row("0412", "Build the queue band", { role: "developer", mode: null })] })));
  assert.match(text, /\b412\b/);
  assert.ok(text.includes("Build the queue band"), text);
  assert.ok(text.includes("developer"), text);
});

test("AC4 the band shows the next 3 proposed tickets, not a fourth", async () => {
  const proposed = [row("501", "Alpha task", { rank: 1 }), row("502", "Bravo task", { rank: 2 }), row("503", "Charlie task", { rank: 4 }), row("504", "Delta task", { rank: 5 })];
  const text = strip(await renderBand(queue({ proposed, ready: proposed })));
  for (const n of ["501", "502", "503"]) assert.match(text, new RegExp(`\\b${n}\\b`));
  assert.doesNotMatch(text, /\b504\b/);
  assert.ok(text.includes("Alpha task") && text.includes("Charlie task"));
  assert.ok(!text.includes("Delta task"));
});

test("AC4 the proposed order wins over ready order", async () => {
  const ready = [row("601", "Ready first"), row("602", "Ready second"), row("603", "Ready third")];
  const proposed = [row("603", "Ready third", { rank: 1 }), row("601", "Ready first", { rank: 2 })];
  const text = strip(await renderBand(queue({ ready, proposed })));
  assert.ok(text.indexOf("603") < text.indexOf("601"), text);
  assert.doesNotMatch(text, /\b602\b/, "602 is not proposed, so it is not shown while a proposed order exists");
});

test("AC4 with no proposed order the band falls back to the top 3 ready tickets", async () => {
  const ready = [row("701", "One"), row("702", "Two"), row("703", "Three"), row("704", "Four")];
  const text = strip(await renderBand(queue({ ready })));
  for (const n of ["701", "702", "703"]) assert.match(text, new RegExp(`\\b${n}\\b`));
  assert.doesNotMatch(text, /\b704\b/);
});

test("AC4 the band is at most two lines, each at most 120 characters, even with many tickets and long titles", async () => {
  const longTitle = "A very long title that keeps going ".repeat(10).trim();
  const inFlight = [1, 2, 3, 4].map((n) => row(`80${n}`, longTitle, { role: "developer" }));
  const proposed = [1, 2, 3, 4, 5].map((n) => row(`81${n}`, longTitle, { rank: n }));
  const out = lines(await renderBand(queue({ inFlight, proposed, ready: proposed })));
  assert.ok(out.length >= 1 && out.length <= 2, `${out.length} lines`);
  for (const l of out) assert.ok([...l].length <= 120, `${[...l].length} chars: ${l}`);
});

test("AC4 with nothing in flight the band shows just the next tickets", async () => {
  const out = lines(await renderBand(queue({ ready: [row("901", "Only ready one")] })));
  assert.equal(out.length, 1);
  assert.match(out[0], /\b901\b/);
});

test("AC4 with only in-flight tickets the band shows just that line", async () => {
  const out = lines(await renderBand(queue({ inFlight: [row("902", "Only in flight", { role: "qa", mode: "verify" })] })));
  assert.equal(out.length, 1);
  assert.match(out[0], /\b902\b/);
});

test("AC4 an empty queue renders nothing", async () => {
  assert.equal(strip(await renderBand(queue())).trim(), "");
});

test("AC4 anything that is not a queue renders nothing and does not throw (the script failed)", async () => {
  for (const bad of [null, undefined, "", "boom", 42, {}, [], { inFlight: "x", ready: 3, proposed: {} }, { error: "ENOENT" }]) {
    assert.equal(strip(await renderBand(bad)).trim(), "", JSON.stringify(bad));
  }
});

test("AC4 the band's data comes from scripts/queue.mjs: its CLI JSON feeds renderBand", async () => {
  const root = boardRoot();
  ticket(root, "alpha/951-shipping", { status: "claimed", title: "Shipping now", lock: "developer 2026-10-09T02:00:00.000Z" });
  ticket(root, "alpha/952-next-up", { title: "Next up soon", priority: "P1" });
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "queue.mjs"), "--json"], { env: { ...process.env, DEN_ROOT: root }, cwd: tmpdir(), encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const text = strip(await renderBand(JSON.parse(r.stdout)));
  assert.match(text, /\b951\b/);
  assert.ok(text.includes("developer"), text);
  assert.match(text, /\b952\b/);
  assert.ok(text.includes("Next up soon"), text);
});

test("AC4 render.mjs is Node-free (a mod runs with no Node): no node: or bare imports", () => {
  const src = readFileSync(RENDER, "utf8");
  assert.doesNotMatch(src, /\bfrom\s+["']node:/);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

test("AC4 register.tsx refreshes from scripts/queue.mjs --json on session start and turn complete, and fails quiet", () => {
  const src = readFileSync(path.join(MOD, "hooks", "register.tsx"), "utf8");
  assert.match(src, /scripts\/queue\.mjs/);
  assert.match(src, /--json/);
  assert.match(src, /session\.start/);
  assert.match(src, /turn\.complete/);
  assert.match(src, /AbovePrompt/);
  assert.match(src, /\bcatch\b/, "a failing script is caught, not thrown");
  assert.match(src, /renderBand/);
});

test("the marketplace lists queue at a relative source that exists, beside sleep-guard and north-star", () => {
  const m = json(".claude-plugin", "marketplace.json");
  const entry = m.plugins.find((p) => p.name === "queue");
  assert.ok(entry, "queue is listed");
  assert.ok(entry.description);
  assert.match(entry.source, /^\.\//);
  assert.equal(path.resolve(REPO_ROOT, entry.source), MOD);
  for (const name of ["sleep-guard", "north-star"]) assert.ok(m.plugins.find((p) => p.name === name), `${name} stays listed`);
});

test("the plugin manifest and hooks module are in place like north-star's", () => {
  const manifest = json("mods", "queue", ".claude-plugin", "plugin.json");
  assert.equal(manifest.name, "queue");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description);
  const hooks = json("mods", "queue", "hooks", "hooks.json");
  assert.ok(Array.isArray(hooks.modules) && hooks.modules.length === 1, "one hooks module");
  assert.match(hooks.modules[0], /^\.\//);
  assert.ok(existsSync(path.join(MOD, "hooks", hooks.modules[0])), `${hooks.modules[0]} exists`);
});
