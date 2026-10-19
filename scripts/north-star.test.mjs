// organism-infra/209: scripts/north-star.mjs reads the board and returns den v1 progress.
//
// Seam (pinned by qa, since the ticket says "for example scripts/north-star.mjs"):
//   export function readNorthStar(root) -> { done, total, remaining, next }   (sync or async)
//     root       board root: the directory that holds .scratch/ (DEN_ROOT in the other scripts)
//     done       count of set tickets whose Status is resolved or closed
//     total      count of set tickets, parked ones excluded
//     remaining  total - done
//     next       the ref `<feature>/<NN-slug>` of the next critical-path ticket, or null
//   CLI: `node scripts/north-star.mjs --json` with DEN_ROOT set prints that object as JSON.
// Blocker refs follow the board's own rules: `NN` is in the same feature, `<feature>/NN` names another;
// trailing prose such as "(merged)" and "None (...)" are not refs.
//
// Criterion map (organism-infra/209):
//   AC1 ticket set + chain          -> "AC1 ..."
//   AC2 done / parked               -> "AC2 ..."
//   AC3 next critical-path ticket   -> "AC3 ..."
//   AC4 no network (module half)    -> "AC4 the module ..."; the statusline half is in
//                                      statusline-north-star.test.mjs
//   AC5 band mod                    -> mods-north-star.test.mjs
//   AC6 marketplace listing         -> mods-north-star.test.mjs; the .claude/settings.json edit in the
//                                      handoff is human-verified (a gated edit; no automated test)
//   AC7 existing statusline tests   -> the unchanged statusline.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boardRoot, ticket } from "./north-star-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, "north-star.mjs");
const read = async (root) => (await import(MODULE)).readNorthStar(root);

test("AC1 the set is every den-v1 ticket plus its blockers, followed through the chain", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-first", { blockedBy: "other/02", status: "ready-for-agent" });
  ticket(root, "other/02-mid", { blockedBy: "other/03", status: "ready-for-agent" });
  ticket(root, "other/03-leaf", { status: "resolved" });
  ticket(root, "other/09-unrelated", { status: "ready-for-agent" });
  const p = await read(root);
  assert.equal(p.total, 3, "den-v1/01, other/02 and other/03 count; other/09 does not");
  assert.equal(p.done, 1);
  assert.equal(p.remaining, 2);
});

test("AC1 same-feature numbers, prose annotations and lists are followed", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "resolved" });
  ticket(root, "den-v1/03-c", { status: "resolved" });
  ticket(root, "den-layout/03-d", { status: "resolved" });
  ticket(root, "den-v1/05-e", { blockedBy: "01, 03 (batch D1: PR #151 must merge first), den-layout/03", status: "ready-for-agent" });
  ticket(root, "den-v1/06-f", { blockedBy: "den-v1/05 (merged)", status: "ready-for-agent" });
  const p = await read(root);
  assert.equal(p.total, 5, "den-layout/03 joins as a blocker of 05");
  assert.equal(p.done, 3);
});

test("AC1 a ticket that only depends on a set ticket is not pulled in (blockers, not dependents)", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "ready-for-agent" });
  ticket(root, "other/04-later", { blockedBy: "den-v1/01", status: "ready-for-agent" });
  assert.equal((await read(root)).total, 1);
});

test("AC1 a blocker that does not exist on the board is ignored", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { blockedBy: "other/77", status: "ready-for-agent" });
  const p = await read(root);
  assert.equal(p.total, 1);
});

test("AC1 a blocker cycle terminates and each ticket counts once", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { blockedBy: "other/02", status: "ready-for-agent" });
  ticket(root, "other/02-b", { blockedBy: "den-v1/01", status: "ready-for-agent" });
  assert.equal((await read(root)).total, 2);
});

test("AC1 the set is recomputed from the board on every read", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "resolved" });
  assert.deepEqual([(await read(root)).done, (await read(root)).total], [1, 1]);
  ticket(root, "den-v1/02-b", { blockedBy: "other/03", status: "ready-for-agent" });
  ticket(root, "other/03-c", { status: "ready-for-agent" });
  const p = await read(root);
  assert.equal(p.total, 3, "a new den-v1 ticket and its new blocker join on their own");
  assert.equal(p.done, 1);
});

test("AC1 the walk continues through a parked blocker: its own blockers join the set, it stays out of the total", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-d", { blockedBy: "other/02", status: "ready-for-agent" });
  ticket(root, "other/02-p", { blockedBy: "other/03", status: "parked" });
  ticket(root, "other/03-q", { status: "ready-for-agent" });
  const p = await read(root);
  assert.equal(p.total, 2, "D and Q count; parked P does not");
  assert.equal(p.next, "other/03-q", "P still blocks D, so Q is the unblocked ticket");
});

test("AC1 an empty board reports zero and no next ticket", async () => {
  const p = await read(boardRoot());
  assert.deepEqual({ done: p.done, total: p.total, remaining: p.remaining, next: p.next }, { done: 0, total: 0, remaining: 0, next: null });
});

test("AC2 resolved and closed count as done; parked drops out of the total", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "resolved" });
  ticket(root, "den-v1/02-b", { status: "closed" });
  ticket(root, "den-v1/03-c", { status: "ready-for-agent" });
  ticket(root, "den-v1/04-d", { status: "in-review" });
  ticket(root, "den-v1/05-e", { status: "parked" });
  const p = await read(root);
  assert.equal(p.done, 2);
  assert.equal(p.total, 4, "parked is not in the total");
  assert.equal(p.remaining, 2);
});

test("AC2 claimed, blocked and ready-for-human are not done", async () => {
  const root = boardRoot();
  for (const [nn, status] of [["01", "claimed"], ["02", "blocked"], ["03", "ready-for-human"]]) ticket(root, `den-v1/${nn}-t`, { status });
  const p = await read(root);
  assert.deepEqual([p.done, p.total, p.remaining], [0, 3, 3]);
});

test("AC3 next is the unblocked ticket with the longest chain of not-done tickets depending on it", async () => {
  const root = boardRoot();
  // 10 -> 11 -> 12 is a chain of three; 20 -> 21 is a chain of two; 30 stands alone.
  ticket(root, "den-v1/10-head", { status: "ready-for-agent" });
  ticket(root, "den-v1/11-mid", { blockedBy: "10", status: "ready-for-agent" });
  ticket(root, "den-v1/12-tail", { blockedBy: "11", status: "ready-for-agent" });
  ticket(root, "den-v1/20-head", { status: "ready-for-agent" });
  ticket(root, "den-v1/21-tail", { blockedBy: "20", status: "ready-for-agent" });
  ticket(root, "den-v1/30-solo", { status: "ready-for-agent" });
  assert.match((await read(root)).next, /^den-v1\/10-head$/);
});

test("AC3 a blocked ticket is never next, even with the longest chain behind it", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-gate", { status: "ready-for-agent" });
  ticket(root, "den-v1/02-blocked", { blockedBy: "01", status: "ready-for-agent" });
  ticket(root, "den-v1/03-after", { blockedBy: "02", status: "ready-for-agent" });
  ticket(root, "den-v1/04-after", { blockedBy: "03", status: "ready-for-agent" });
  const next = (await read(root)).next;
  assert.equal(next, "den-v1/01-gate", "02 has a longer chain than 01 behind it but is blocked by 01");
});

test("AC3 a blocker that is resolved or closed no longer blocks", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-done", { status: "resolved" });
  ticket(root, "den-v1/02-closed", { status: "closed" });
  ticket(root, "den-v1/03-ready", { blockedBy: "01, 02", status: "ready-for-agent" });
  ticket(root, "den-v1/04-after", { blockedBy: "03", status: "ready-for-agent" });
  assert.equal((await read(root)).next, "den-v1/03-ready");
});

test("AC3 parked dependents do not lengthen the chain", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "ready-for-agent" });
  ticket(root, "den-v1/02-parked", { blockedBy: "01", status: "parked" });
  ticket(root, "den-v1/03-parked", { blockedBy: "02", status: "parked" });
  ticket(root, "den-v1/04-b", { status: "ready-for-agent" });
  ticket(root, "den-v1/05-live", { blockedBy: "04", status: "ready-for-agent" });
  assert.equal((await read(root)).next, "den-v1/04-b", "01 has only parked tickets behind it, 04 has one live ticket");
});

test("AC3 a claimed ticket is still unblocked and not done, so it can be next", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-in-flight", { status: "claimed" });
  ticket(root, "den-v1/02-after", { blockedBy: "01", status: "ready-for-agent" });
  ticket(root, "den-v1/03-solo", { status: "ready-for-agent" });
  assert.equal((await read(root)).next, "den-v1/01-in-flight");
});

test("AC3 chain length counts the longest path through a diamond, each ticket once", async () => {
  const root = boardRoot();
  // 01 -> 02 -> 04 and 01 -> 03 -> 04 (04 blocked by both): chain behind 01 is three tickets (02, 03, 04).
  ticket(root, "den-v1/01-root", { status: "ready-for-agent" });
  ticket(root, "den-v1/02-l", { blockedBy: "01", status: "ready-for-agent" });
  ticket(root, "den-v1/03-r", { blockedBy: "01", status: "ready-for-agent" });
  ticket(root, "den-v1/04-join", { blockedBy: "02, 03", status: "ready-for-agent" });
  // 10 -> 11 -> 12: chain behind 10 is two tickets, so 01 wins.
  ticket(root, "den-v1/10-b", { status: "ready-for-agent" });
  ticket(root, "den-v1/11-b", { blockedBy: "10", status: "ready-for-agent" });
  ticket(root, "den-v1/12-b", { blockedBy: "11", status: "ready-for-agent" });
  assert.equal((await read(root)).next, "den-v1/01-root");
});

test("AC3 ties go to frontier order: higher priority first, then the lower number", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-p2", { status: "ready-for-agent" });
  ticket(root, "den-v1/02-p1", { status: "ready-for-agent", priority: "P1" });
  ticket(root, "den-v1/03-p1", { status: "ready-for-agent", priority: "P1" });
  assert.equal((await read(root)).next, "den-v1/02-p1", "equal chains: P1 beats P2 (missing priority), then the lower number");
});

test("AC3 with every ticket done there is no next ticket", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "resolved" });
  ticket(root, "den-v1/02-b", { status: "closed", blockedBy: "01" });
  const p = await read(root);
  assert.equal(p.next, null);
  assert.deepEqual([p.done, p.total, p.remaining], [2, 2, 0]);
});

test("AC3 when nothing in the set is unblocked there is no next ticket (only blocked tickets remain)", async () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "blocked", blockedBy: "other/09" });
  ticket(root, "other/09-b", { status: "blocked", blockedBy: "den-v1/01" });
  assert.equal((await read(root)).next, null);
});

test("AC4 the module reads only the board: the CLI prints the same numbers as JSON and the source imports no network or usage code", () => {
  const root = boardRoot();
  ticket(root, "den-v1/01-a", { status: "resolved" });
  ticket(root, "den-v1/02-b", { blockedBy: "01", status: "ready-for-agent" });
  const r = spawnSync(process.execPath, [MODULE, "--json"], { env: { ...process.env, DEN_ROOT: root }, cwd: root, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { done: 1, total: 2, remaining: 1, next: "den-v1/02-b" });
  const src = readFileSync(MODULE, "utf8");
  assert.doesNotMatch(src, /from\s+["'](?:node:)?(?:https?|net|tls|dns|http2)["']/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /from\s+["'][^"']*usage[^"']*["']/);
});
