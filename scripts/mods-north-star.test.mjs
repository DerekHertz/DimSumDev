// organism-infra/209: the north-star band mod, packaged like mods/sleep-guard.
//
// Seams pinned by qa:
//   mods/north-star/hooks/render.mjs   export function renderBand(progress) -> string
//     progress is the object scripts/north-star.mjs returns: { done, total, remaining, next }.
//     It is pure and dependency-free (a mod runs with no Node), e.g. `████████░░░░ v1 8/12 · next: 143`.
//     `next: <n>` is the ticket number without leading zeros; no `next:` when there is none; total 0 -> "".
//   mods/north-star/.claude-plugin/plugin.json, mods/north-star/hooks/hooks.json ({ "modules": [..] })
//   .claude-plugin/marketplace.json lists "north-star" at a relative source
// Criterion map: AC5 band renders bar, count and next from the same module -> "AC5 ..."
//                AC6 marketplace lists the mod                              -> "AC6 ..."
//                AC6 the .claude/settings.json edit in the handoff          -> human-verified
//                Mod drawing in a live terminal claude session              -> human-verified
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../apps/board/board-fixture.mjs";
import { boardRoot, ticket } from "./north-star-fixture.mjs";

const MOD = path.join(REPO_ROOT, "mods", "north-star");
const RENDER = path.join(MOD, "hooks", "render.mjs");
const renderBand = async (p) => (await import(RENDER)).renderBand(p);
const json = (...p) => JSON.parse(readFileSync(path.join(REPO_ROOT, ...p), "utf8"));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("AC5 renderBand shows the bar, the count and the next ticket number", async () => {
  const text = strip(await renderBand({ done: 8, total: 12, remaining: 4, next: "den-v1/143-build-the-thing" }));
  const bar = /([█░]+) v1 8\/12 · next: 143\b/.exec(text);
  assert.ok(bar, text);
  const filled = [...bar[1]].filter((c) => c === "█").length;
  assert.ok(Math.abs(filled / bar[1].length - 8 / 12) <= 0.1, `bar ${bar[1]} should be about two thirds full`);
});

test("AC5 renderBand trims leading zeros from the next ticket number", async () => {
  assert.match(strip(await renderBand({ done: 1, total: 4, remaining: 3, next: "den-v1/05-x" })), /next: 5\b/);
});

test("AC5 renderBand with nothing left shows a full bar and no next ticket", async () => {
  const text = strip(await renderBand({ done: 3, total: 3, remaining: 0, next: null }));
  assert.match(text, /v1 3\/3/);
  assert.doesNotMatch(text, /next:/);
  assert.doesNotMatch(text, /░/);
});

test("AC5 renderBand with an empty set renders nothing", async () => {
  assert.equal(strip(await renderBand({ done: 0, total: 0, remaining: 0, next: null })).trim(), "");
});

test("AC5 the band's numbers come from the north-star module: its CLI JSON feeds renderBand", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "resolved" });
  ticket(root, "den-v1/02-b", { blockedBy: "01", status: "ready-for-agent" });
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "north-star.mjs"), "--json"], { env: { ...process.env, DEN_ROOT: root }, cwd: root, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(strip(await renderBand(JSON.parse(r.stdout))), /v1 1\/2 · next: 2\b/);
});

test("AC5 render.mjs is Node-free (a mod runs with no Node): no node: or bare imports", () => {
  const src = readFileSync(RENDER, "utf8");
  assert.doesNotMatch(src, /\bfrom\s+["']node:/);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bimport\s*\(/);
});

test("AC6 the marketplace lists north-star at a relative source that exists, next to sleep-guard", () => {
  const m = json(".claude-plugin", "marketplace.json");
  const entry = m.plugins.find((p) => p.name === "north-star");
  assert.ok(entry, "north-star is listed");
  assert.ok(entry.description);
  assert.match(entry.source, /^\.\//);
  assert.equal(path.resolve(REPO_ROOT, entry.source), MOD);
  assert.ok(m.plugins.find((p) => p.name === "sleep-guard"), "sleep-guard stays listed");
});

test("AC6 the plugin manifest and hooks module are in place like sleep-guard's", () => {
  const manifest = json("mods", "north-star", ".claude-plugin", "plugin.json");
  assert.equal(manifest.name, "north-star");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description);
  const hooks = json("mods", "north-star", "hooks", "hooks.json");
  assert.ok(Array.isArray(hooks.modules) && hooks.modules.length === 1, "one hooks module");
  assert.match(hooks.modules[0], /^\.\//);
  assert.ok(existsSync(path.join(MOD, "hooks", hooks.modules[0])), `${hooks.modules[0]} exists`);
});
