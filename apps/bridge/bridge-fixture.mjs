// Test-only helper for dimsumden-ui-v0/04 (bridge GET /state). Builds a
// disposable "main checkout" holding a .scratch/ tree: tickets, claim locks,
// events.jsonl rows, orchestrator handoffs, usage.jsonl and requests.jsonl.
// Not a test file (no .test.mjs suffix), so `npm test` skips it.
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

export const FEATURE = "fx";
export const GOAL_KEY = "fx-goal";
export const BIG_HANDOFF = "BIG-LINE ".repeat(3000); // 27000 ASCII bytes, over the 8 KB cap
export const SMALL_HANDOFF = "## State\nhello handoff\n";
export const PENDING_ID = "6f1c1b7e-0d55-4c3a-9b52-1f5d7e0a9a10";
export const HANDLED_ID = "0a0a0a0a-0d55-4c3a-9b52-1f5d7e0a9a11";
export const LOCK_TS = "2026-09-29T06:00:00.000Z";

function ticketMd({ title, type = "feature", priority, status, blockedBy = "None", goal, comments = [] }) {
  return [
    `# ${title}`,
    "",
    `**Type:** ${type}`,
    "",
    ...(goal ? [`**Goal:** ${goal}`, ""] : []),
    ...(priority ? [`**Priority:** ${priority}`, ""] : []),
    "**What to build:** something.",
    "",
    `**Blocked by:** ${blockedBy}`,
    "",
    `**Status:** ${status}`,
    "",
    "- [ ] a criterion",
    "",
    "## Comments",
    "",
    ...comments.map((c) => `- ${c}`),
    "",
  ].join("\n");
}

async function put(file, text, mtime) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  if (mtime) await utimes(file, new Date(mtime), new Date(mtime));
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// Tickets in feature "fx" (and "beta"):
//  01-done            resolved (omitted from the snapshot)
//  02-ready-p0        ready, P0, mtime 09-15
//  03-blocked-dep     ready-for-agent but blocked by 02, beta/01 (resolved), 99 (missing)
//  04-review          in-review, no lock, newest verdict is security pass; pending request; 2 handoffs
//  05-blocked         status blocked, last comment bullet is the reason
//  06-human           ready-for-human, huge handoff
//  07-bumpable        ready, P1, mtime 09-20 (older than 08; no aging bump since queue/06)
//  08-plain           ready, no priority (P2), mtime 09-29 (newest, after 07)
//  09-claimed         (only when lock: true) status claimed with a claim lock
//  git: true         the root is a git repository with one (empty) commit, so the host can add agent worktrees
export async function makeStateFixture({ lock = false, empty = false, git = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-fx-"));
  const scratch = path.join(root, ".scratch");
  await mkdir(scratch, { recursive: true });
  if (!empty) {
    // den-mvp/61: the user's goals; 02 names one.
    await writeFile(path.join(scratch, "goals.md"), `# Goals\n\n| Key | Goal | Why | Done when |\n|---|---|---|---|\n| \`${GOAL_KEY}\` | The fixture goal | To test goals. | Never. |\n`);
    const iss = (n) => path.join(scratch, FEATURE, "issues", `${n}.md`);
    await put(iss("01-done"), ticketMd({ title: "01: Done thing", status: "resolved" }), "2026-09-10T00:00:00Z");
    await put(iss("02-ready-p0"), ticketMd({ title: "02: Ready P0", priority: "P0", status: "ready-for-agent", blockedBy: "01", goal: GOAL_KEY }), "2026-09-15T00:00:00Z");
    await put(
      iss("03-blocked-dep"),
      ticketMd({ title: "03: Blocked dep", type: "design", priority: "P1", status: "ready-for-agent", blockedBy: "02, beta/01 (note), 99" }),
      "2026-09-16T00:00:00Z",
    );
    await put(iss("04-review"), ticketMd({ title: "04: In review", type: "bug", priority: "P2", status: "in-review" }), "2026-09-17T00:00:00Z");
    await put(
      iss("05-blocked"),
      ticketMd({ title: "05: Blocked", status: "blocked", comments: ["first note", "Waiting on the user for the API key"] }),
      "2026-09-18T00:00:00Z",
    );
    await put(iss("06-human"), ticketMd({ title: "06: Human", status: "ready-for-human" }), "2026-09-19T00:00:00Z");
    await put(iss("07-bumpable"), ticketMd({ title: "07: Bumpable", priority: "P1", status: "ready-for-agent" }), "2026-09-20T00:00:00Z");
    await put(iss("08-plain"), ticketMd({ title: "08: Plain", status: "ready-for-agent" }), "2026-09-29T00:00:00Z");
    if (lock) {
      await put(iss("09-claimed"), ticketMd({ title: "09: Claimed", status: "claimed" }), "2026-09-21T00:00:00Z");
      await put(path.join(scratch, FEATURE, "issues", "09-claimed.lock"), `developer ${LOCK_TS}\n`);
    }
    await put(
      path.join(scratch, "beta", "issues", "01-other.md"),
      ticketMd({ title: "01: Other feature", status: "resolved" }),
      "2026-09-10T00:00:00Z",
    );

    const ho = (n) => path.join(scratch, FEATURE, "handoffs", n);
    await put(ho("04-old.md"), "old handoff\n", "2026-09-20T10:00:00Z");
    await put(ho("04-new.md"), SMALL_HANDOFF, "2026-09-25T10:00:00Z");
    await put(ho("05-other.md"), "not for 04\n", "2026-09-26T10:00:00Z");
    await put(ho("06-big.md"), BIG_HANDOFF, "2026-09-25T11:00:00Z");

    for (const n of [1, 2, 3]) {
      await put(path.join(scratch, "_handoffs", `2026-09-28-orchestrator-${n}.md`), "x\n", "2026-09-28T12:00:00Z");
    }
    await put(path.join(scratch, "_handoffs", "2026-09-28-architect-1.md"), "x\n", "2026-09-28T12:00:00Z");

    await put(
      path.join(scratch, "events.jsonl"),
      jsonl([
        { seq: 1, ts: "2026-09-26T00:00:00.000Z", feature: FEATURE, ticket: "04-review", role: "developer", op: "release", to_status: "in-review" },
        { seq: 2, ts: "2026-09-26T01:00:00.000Z", feature: FEATURE, ticket: "04-review", role: "security", op: "comment", text: "Security pass", verdict: "pass" },
        { seq: 3, ts: "2026-09-26T02:00:00.000Z", feature: FEATURE, ticket: "05-blocked", role: "qa", op: "release", to_status: "blocked" },
      ]),
    );
    await put(
      path.join(scratch, "usage.jsonl"),
      jsonl([
        { kind: "usage", ts: "2026-09-29T04:00:00.000Z", five_hour: 40, weekly: 50 },
        { kind: "agent", ts: "2026-09-29T04:10:00.000Z", ticket: "fx/02", role: "developer", tokens: 10 },
        { kind: "usage", ts: "2026-09-29T04:36:50.650Z", five_hour: 74, weekly: 72 },
        { kind: "usage", ts: "2026-09-29T05:00:00.000Z", note: "no numeric five_hour" },
        { kind: "incident", ts: "2026-09-29T05:10:00.000Z", tool: "git" },
      ]),
    );
    await put(
      path.join(scratch, "_requests", "requests.jsonl"),
      jsonl([
        { id: HANDLED_ID, ts: "2026-09-29T05:00:00.000Z", kind: "dispatch-approve", ref: `${FEATURE}/08-plain`, note: "go" },
        { handled: HANDLED_ID, ts: "2026-09-29T05:05:00.000Z", outcome: "dispatched" },
        { id: PENDING_ID, ts: "2026-09-29T05:58:00.000Z", kind: "merge-approve", ref: `${FEATURE}/04-review`, note: "ship it" },
      ]),
    );
  }
  if (git) {
    const run = (...args) =>
      promisify(execFile)("git", ["-C", root, "-c", "user.name=fx", "-c", "user.email=fx@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args]);
    await run("init", "-q", "-b", "main");
    await run("commit", "-q", "--allow-empty", "-m", "fixture");
  }
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}
