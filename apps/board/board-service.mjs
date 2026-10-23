// organism-infra/02: the board service — the single writer of the board.
// Implements markdown parsing/editing, per-mutation locking, atomic writes
// and event sequencing per docs/adr/0008-board-service.md. `board.mjs` is
// its only adapter today (CLI, in-process); a daemon-IPC wrapper can be
// added later without changing this module's interface.
import { goalProblem } from "./goals.mjs";
import {
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
  realpath,
  open,
  mkdir,
  link,
  readdir,
  lstat,
  appendFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { constants as fsConstants, existsSync, readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { validateState } from "./schemas.mjs";
import { roleOf } from "./legacy-terms.mjs";

export const STATUSES = [
  "ready-for-agent",
  "claimed",
  "in-review",
  "resolved",
  "blocked",
  "ready-for-human",
];

const MAX_ARG_LEN = 4000;
const TICKET_TEXT_MAX = 8192; // a ticket body; a design ticket runs past the other arguments' bound (F34)
const WRITE_LOCK_AGE_FLOOR_MS = 5000;
// Total time a mutation waits on a live write lock before giving up.
const WRITE_LOCK_WAIT_MS = 2500;
const BACKOFF_START_MS = 20;
const BACKOFF_CAP_MS = 400;
// Windows refuses a rename over a file another process has open.
const RENAME_RETRY_MS = 1000;

// Gates every BOARD_TEST_* test-only seam (fault injection, interleaving
// hooks, hold logging): inert in production even if the env vars leak in.
const TEST_HOOKS_ENABLED = process.env.NODE_ENV !== "production";

export class BoardError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoardError";
  }
}

// The write lock stayed held for the whole bounded wait. The CLI maps this to
// exit code 75 (EX_TEMPFAIL): retrying later may succeed.
export class LockTimeoutError extends BoardError {
  constructor(message) {
    super(message);
    this.name = "LockTimeoutError";
    this.exitCode = 75;
  }
}

// --- Root resolution --------------------------------------------------------

export function resolveRoot(cwd, env) {
  // ADR 0028: $DEN_ROOT, else the old $ORGANISM_ROOT for one release.
  const envRoot = env.DEN_ROOT || env.ORGANISM_ROOT;
  if (envRoot) {
    return path.resolve(envRoot);
  }
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/^worktree (.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // fall through to error below
  }
  throw new BoardError(
    "could not resolve the main checkout: set $DEN_ROOT or run inside a git worktree"
  );
}

// --- Validation --------------------------------------------------------------

const FEATURE_RE = /^[a-z0-9-]+$/;
const TICKET_RE = /^\d{2,}-[a-z0-9-]+$/;

export function checkArgLength(value, name) {
  if (typeof value === "string" && value.length > MAX_ARG_LEN) {
    throw new BoardError(`${name} exceeds the maximum length of ${MAX_ARG_LEN}`);
  }
}

export function parseTicketRef(ref) {
  checkArgLength(ref, "ticket ref");
  const parts = typeof ref === "string" ? ref.split("/") : [];
  if (parts.length !== 2) {
    throw new BoardError(`invalid ticket ref: ${ref}`);
  }
  const [feature, ticket] = parts;
  if (!FEATURE_RE.test(feature)) {
    throw new BoardError(`invalid feature segment: ${feature}`);
  }
  if (!TICKET_RE.test(ticket)) {
    throw new BoardError(`invalid ticket segment: ${ticket}`);
  }
  return { feature, ticket };
}

// organism-infra/126: the one short-ref resolver. <feature>/<NN> (the whole numeric
// segment) resolves to the full <feature>/<NN-slug> of the one issue file whose name
// starts with "<NN>-". A ref that is not short passes through unchanged. Zero or two
// or more matches throw. Used by the board CLI, log-agent.mjs and jev.mjs.
export function resolveShortRef(root, ref) {
  checkArgLength(ref, "ticket ref");
  const m = typeof ref === "string" ? /^([a-z0-9-]+)\/(\d+)$/.exec(ref) : null;
  if (!m) return ref;
  const [, feature, nn] = m;
  let names = [];
  try {
    names = readdirSync(path.join(root, ".scratch", feature, "issues"));
  } catch {
    // no such feature: reported as no match below
  }
  const hits = names.filter((n) => n.startsWith(`${nn}-`) && n.endsWith(".md")).map((n) => n.slice(0, -3));
  if (hits.length === 0) throw new BoardError(`ticket not found: ${ref} (no issue file starting ${nn}- in .scratch/${feature}/issues)`);
  if (hits.length > 1) throw new BoardError(`ambiguous ticket ref ${ref}: matches ${hits.map((h) => `${feature}/${h}`).join(", ")}`);
  return `${feature}/${hits[0]}`;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Walks up from targetPath to the nearest existing ancestor, resolves it
// through any symlinks, and rejects if that real path falls outside root.
// Catches both plain traversal (already caught earlier by parseTicketRef)
// and a symlinked directory under the board that points outside it.
async function assertWithinRoot(root, targetPath) {
  const realRoot = await realpath(root);
  let current = targetPath;
  for (;;) {
    if (await exists(current)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const realCurrent = await realpath(current).catch(() => current);
  const rel = path.relative(realRoot, realCurrent);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new BoardError(`path escapes the board root: ${targetPath}`);
  }
}

// --- Paths --------------------------------------------------------------------

export function boardPaths(root, feature, ticket) {
  const issuesDir = path.join(root, ".scratch", feature, "issues");
  return {
    issuesDir,
    ticketPath: path.join(issuesDir, `${ticket}.md`),
    claimLockPath: path.join(issuesDir, `${ticket}.lock`),
    writeLockPath: path.join(issuesDir, `${ticket}.write-lock.json`),
    eventsPath: path.join(root, ".scratch", "events.jsonl"),
  };
}

// --- Atomic writes -------------------------------------------------------------

// Full-jitter exponential backoff: a random delay in [1, min(cap, start*2^n)].
function backoffDelay(attempt) {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** attempt);
  return Math.max(1, Math.round(Math.random() * ceiling));
}

const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameWithRetry(from, to) {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (!RETRYABLE_RENAME.has(err.code) || Date.now() >= deadline) throw err;
      await sleep(backoffDelay(attempt));
    }
  }
}

// Test-only fault injection for the reclaim unlink below (gated the same as
// every other BOARD_TEST_* seam): BOARD_TEST_FORCE_UNLINK_ERR=<code> +
// BOARD_TEST_FORCE_UNLINK_COUNT=<n> makes the next n unlinkWithRetry calls
// throw that error code before falling through to the real unlink, so a test
// can exercise the EPERM/EBUSY/EACCES retry path without depending on a real
// OS-level file lock.
let testForceUnlinkFailuresLeft = TEST_HOOKS_ENABLED
  ? Number(process.env.BOARD_TEST_FORCE_UNLINK_COUNT || 0)
  : 0;

// Windows can also refuse an unlink of a file another process has open
// (e.g. mid-read); retry it the same bounded way as a rename.
async function unlinkWithRetry(target) {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      if (TEST_HOOKS_ENABLED && testForceUnlinkFailuresLeft > 0 && process.env.BOARD_TEST_FORCE_UNLINK_ERR) {
        testForceUnlinkFailuresLeft -= 1;
        const err = new Error("test-injected unlink failure");
        err.code = process.env.BOARD_TEST_FORCE_UNLINK_ERR;
        throw err;
      }
      return await unlink(target);
    } catch (err) {
      if (!RETRYABLE_RENAME.has(err.code) || Date.now() >= deadline) throw err;
      await sleep(backoffDelay(attempt));
    }
  }
}

async function atomicWrite(filePath, content) {
  // Unique temp name: two writers never share (and clobber) one temp file.
  const tmp = `${filePath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// --- Write lock -----------------------------------------------------------------

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function tryCreateLock(lockPath, raw) {
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(raw);
  } finally {
    await handle.close();
  }
}

// Removes the lock only if it is still ours (token match), so a release can
// never delete a lock another process has since taken.
function releaser(lockPath, raw) {
  return async () => {
    const current = await readFile(lockPath, "utf8").catch(() => null);
    if (current === raw) await unlink(lockPath).catch(() => {});
  };
}

function isReclaimable(existing) {
  const sameHost = existing.host === os.hostname();
  const alive = isPidAlive(existing.pid);
  const ageMs = Date.now() - Date.parse(existing.createdAt);
  // Test-only override (gated like every BOARD_TEST_* seam) so a test about a
  // lock younger than the floor does not depend on how long process startup
  // took on a busy machine.
  const floorMs =
    TEST_HOOKS_ENABLED && process.env.BOARD_TEST_WRITE_LOCK_AGE_FLOOR_MS !== undefined
      ? Number(process.env.BOARD_TEST_WRITE_LOCK_AGE_FLOOR_MS)
      : WRITE_LOCK_AGE_FLOOR_MS;
  return sameHost && !alive && ageMs > floorMs;
}

// Creates `filePath` exclusively with its full content in one step (temp file
// plus hard link), so the file is never observed empty or half-written.
async function createExclusive(filePath, content) {
  const tmp = `${filePath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await link(tmp, filePath);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// Sweeps `<lockPath>.reclaim-*` mutex files left behind by a prior reclaim
// whose stale lock is already gone (security finding: orphaned tombstones
// can accumulate when generations are exhausted or content changes before
// cleanup, board-service.mjs:251-290 as of ticket 13). Only ever called right
// after this process created `lockPath` fresh (no lock existed to block us),
// so any `.reclaim-*` sibling at that moment cannot belong to a live reclaim.
async function sweepOrphanedReclaimFiles(lockPath) {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.reclaim-`;
  const entries = await readdir(dir).catch(() => []);
  await Promise.all(
    entries.filter((e) => e.startsWith(prefix)).map((e) => unlink(path.join(dir, e)).catch(() => {}))
  );
}

const RECLAIM_GENERATIONS = 8;

// Removes a lock judged stale, race-free. Returns true only if this call
// removed it. Invariant argument: .scratch/organism-infra/handoffs/13-developer.md.
//
// Reclaimers of one stale lock serialize on a reclaim mutex named after that
// lock's exact content: `<lock>.reclaim-<hash(staleRaw)>-<g>`, created
// exclusively. Holding it, we re-read the lock and remove it only if it is
// still byte-identical to what we judged stale and still meets the reclaim
// rules. Nothing else can change the lock file in between: its owner is dead,
// releasers only remove their own token, acquirers only create at an empty
// path, and every other reclaimer of this content is shut out by the mutex
// (reclaimers of other content see different bytes and do nothing).
//
// A mutex holder that crashes would block reclaim forever, so its rule: if
// generation g is held by a dead pid on this host, move on to g+1. A process
// holds generation g only if every lower generation's holder was dead when it
// looked, and dead stays dead, so at most one live process holds any
// generation. Mutex files are deleted only after the stale lock is gone, when
// holding one no longer lets anyone remove anything.
async function reclaimStale(lockPath, staleRaw, stale) {
  const id = createHash("sha256").update(staleRaw).digest("hex").slice(0, 16);
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname() });
  const mutexPath = (g) => `${lockPath}.reclaim-${id}-${g}`;

  for (let g = 0; g < RECLAIM_GENERATIONS; g++) {
    try {
      await createExclusive(mutexPath(g), mine);
    } catch (err) {
      if (err.code !== "EEXIST") return false;
      const holderRaw = await readFile(mutexPath(g), "utf8").catch(() => null);
      if (holderRaw === null) return false; // just cleaned up: the stale lock is gone
      let holder = null;
      try {
        holder = JSON.parse(holderRaw);
      } catch {
        return false;
      }
      if (holder && holder.host === os.hostname() && !isPidAlive(holder.pid)) continue;
      return false; // a live reclaimer is on it: back off
    }

    let gone = false;
    let removed = false;
    try {
      const current = await readFile(lockPath, "utf8").catch(() => null);
      gone = current !== staleRaw;
      if (!gone && isReclaimable(stale)) {
        await testHook("reclaim-gap");
        await unlinkWithRetry(lockPath);
        gone = removed = true;
      }
    } finally {
      const cleanup = gone ? Array.from({ length: g + 1 }, (_, i) => mutexPath(i)) : [mutexPath(g)];
      await Promise.all(cleanup.map((p) => unlink(p).catch(() => {})));
    }
    return removed;
  }
  return false;
}

// Acquires the per-ticket write lock (ADR 0008 decision 2). A live lock is
// waited on with bounded, full-jitter exponential backoff (sleeping, never
// spinning) and never stolen; after WRITE_LOCK_WAIT_MS it throws
// LockTimeoutError. Reclaim rules are unchanged: same host, dead pid, and
// older than the age floor.
async function acquireWriteLock(lockPath) {
  const raw = JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    createdAt: new Date().toISOString(),
    token: randomBytes(8).toString("hex"),
  });
  // Test-only override so a test can force the deadline to have already
  // passed without a multi-second real-time wait (gated like every other
  // BOARD_TEST_* seam).
  const waitMs =
    TEST_HOOKS_ENABLED && process.env.BOARD_TEST_WRITE_LOCK_WAIT_MS !== undefined
      ? Number(process.env.BOARD_TEST_WRITE_LOCK_WAIT_MS)
      : WRITE_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let lastReason = "is held by another process";

  for (let attempt = 0; ; attempt++) {
    try {
      await tryCreateLock(lockPath, raw);
      await sweepOrphanedReclaimFiles(lockPath);
      return releaser(lockPath, raw);
    } catch (err) {
      // On Windows a just-unlinked lock can linger delete-pending while a
      // reader has it open, and create then fails with EPERM: treat as busy.
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(err.code)) throw err;
    }

    const existingRaw = await readFile(lockPath, "utf8").catch(() => null);
    let existing = null;
    if (existingRaw !== null) {
      try {
        existing = JSON.parse(existingRaw);
        if (!existing || typeof existing !== "object") throw new Error("not a lock object");
        lastReason = `is held by pid ${existing.pid} on ${existing.host}`;
      } catch {
        // Mid-write by its creator, or corrupt: treat as held.
        lastReason = "is held and unreadable";
      }
    }

    // Retry the create at once only after removing a stale lock ourselves.
    // Every other path (live lock, lost reclaim race, vanished lock) sleeps,
    // so no interleaving can spin, and the deadline bounds the whole wait.
    if (existing && isReclaimable(existing)) {
      await testHook("stale-judged");
      const reclaimed = await reclaimStale(lockPath, existingRaw, existing);
      await testHook("post-reclaim");
      // A successful self-reclaim retries the create at once (no sleep), so
      // without this check the deadline below would never run: a lock that
      // keeps coming back stale (e.g. repeatedly recreated by another party)
      // could loop past WRITE_LOCK_WAIT_MS indefinitely instead of bailing
      // out with LockTimeoutError like every other path does.
      if (reclaimed) {
        if (Date.now() >= deadline) {
          throw new LockTimeoutError(
            `write lock ${lastReason}; gave up after ${waitMs}ms, retry later (${lockPath})`
          );
        }
        continue;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new LockTimeoutError(
        `write lock ${lastReason}; gave up after ${waitMs}ms, retry later (${lockPath})`
      );
    }
    await sleep(Math.min(backoffDelay(attempt), remaining));
  }
}

async function withWriteLock(lockPath, fn) {
  const release = await acquireWriteLock(lockPath);
  const hold = await testHoldStart(lockPath);
  try {
    return await fn();
  } finally {
    await testHoldEnd(lockPath, hold);
    await release();
  }
}

// --- Test seam (inert unless BOARD_TEST_* env vars are set) -----------------------
// Lets tests force exact multi-process interleavings of the lock code.
// BOARD_TEST_HOOK_DIR + BOARD_TEST_HOOKS=<point,...>: at each listed point the
//   process writes <dir>/<point>.reached and waits (bounded) for <dir>/<point>.go.
// BOARD_TEST_HOLD_LOG=<dir> [+ BOARD_TEST_HOLD_MS]: every lock hold is logged to
//   its own file in <dir> as {lock, pid, acquiredAt, releasedAt}, and lasts at
//   least BOARD_TEST_HOLD_MS, so tests can assert that no two holds overlap.
//
// Gated on NODE_ENV !== "production" (security finding, ticket 12/13): these
// hooks can pause a live mutation on an external signal file, so a production
// deploy must never honor them even if the env vars leak in somehow.

async function testHook(point) {
  if (!TEST_HOOKS_ENABLED) return;
  const dir = process.env.BOARD_TEST_HOOK_DIR;
  const points = (process.env.BOARD_TEST_HOOKS || "").split(",");
  if (!dir || !points.includes(point)) return;
  await writeFile(path.join(dir, `${point}.reached`), String(process.pid));
  const go = path.join(dir, `${point}.go`);
  const deadline = Date.now() + 15000;
  while (!(await exists(go)) && Date.now() < deadline) await sleep(20);
}

async function testHoldStart(lockPath) {
  if (!TEST_HOOKS_ENABLED) return null;
  if (!process.env.BOARD_TEST_HOLD_LOG) return null;
  const acquiredAt = Date.now();
  const ms = Number(process.env.BOARD_TEST_HOLD_MS || 0);
  // Stretch only ticket-lock holds; the nested events lock stays short.
  if (ms > 0 && !path.basename(lockPath).startsWith("events.")) await sleep(ms);
  return acquiredAt;
}

async function testHoldEnd(lockPath, acquiredAt) {
  if (!TEST_HOOKS_ENABLED) return;
  const dir = process.env.BOARD_TEST_HOLD_LOG;
  if (!dir || acquiredAt === null) return;
  const record = { lock: path.basename(lockPath), pid: process.pid, acquiredAt, releasedAt: Date.now() };
  const name = `hold-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  await writeFile(path.join(dir, name), JSON.stringify(record));
}

// --- Events ---------------------------------------------------------------------

// events.jsonl is shared by every ticket, so the per-ticket write lock does
// not serialize it. A board-wide events lock (same bounded wait and reclaim
// rules) guards it. Lock order is always ticket lock, then events lock, so no
// deadlock. The events lock is taken before any ticket write: a timeout on
// either lock leaves nothing written, so a ticket change and its event line
// land together or not at all.
// `events` is a single event object (existing callers) or an array of them
// (organism-infra/18: `release --force` logs both the ordinary release event
// and a `kind:"override"` event in the same commit). Multiple events append
// as consecutive, monotonically-sequenced lines under one lock hold.
async function commitWithEvent(eventsPath, writeTicket, events) {
  await mkdir(path.dirname(eventsPath), { recursive: true });
  const eventList = Array.isArray(events) ? events : [events];
  return withWriteLock(`${eventsPath}.write-lock.json`, async () => {
    await writeTicket();
    const results = [];
    for (const event of eventList) {
      results.push(await appendEventLocked(eventsPath, event));
    }
    return results.length === 1 ? results[0] : results;
  });
}

// Caller holds the events lock. A whole-file temp write plus rename, not an
// `a`-flag append: O_APPEND is not an atomic append on Windows, and the
// rename means a reader never sees a torn line.
async function appendEventLocked(eventsPath, event) {
  const current = await readFile(eventsPath, "utf8").catch((err) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  let lastSeq = 0;
  const lines = current.trim().split("\n").filter(Boolean);
  if (lines.length > 0) {
    try {
      lastSeq = JSON.parse(lines[lines.length - 1]).seq ?? 0;
    } catch {
      lastSeq = 0;
    }
  }
  const full = { seq: lastSeq + 1, ts: new Date().toISOString(), ...event };
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await atomicWrite(eventsPath, `${prefix}${JSON.stringify(full)}\n`);
  return full;
}

// --- Ticket helpers ---------------------------------------------------------------

// The header status line: `**Status:** value` (the real format) or plain
// `Status: value`, at the start of a line, before the first `## ` section.
// Status text mid-line in body prose, or anywhere under ## Comments, never
// matches.
const STATUS_LINE_RE = /^(\*\*Status:\*\*|\*\*Status\*\*:|Status:)([ \t]*)([^\s*]+)/m;

function findStatus(content) {
  const section = /^## /m.exec(content);
  const header = section ? content.slice(0, section.index) : content;
  const m = STATUS_LINE_RE.exec(header);
  if (!m) return undefined;
  return { index: m.index, label: m[1], gap: m[2] || " ", value: m[3], length: m[0].length };
}

export function readStatus(content) {
  return findStatus(content)?.value;
}

function replaceStatus(content, newStatus) {
  const found = findStatus(content);
  if (!found) {
    throw new BoardError("ticket has no header status line (**Status:** <value>)");
  }
  return (
    content.slice(0, found.index) +
    found.label +
    found.gap +
    newStatus +
    content.slice(found.index + found.length)
  );
}

// JS regex `^`/`$` in multiline mode -- the shape STAMP_RE and
// STATUS_LINE_RE use -- treat LF, CR, CRLF, U+2028 (LINE SEPARATOR) and
// U+2029 (PARAGRAPH SEPARATOR) all as line terminators, not just "\n".
const LINE_TERMINATOR_RE = new RegExp("\r\n|[\n\r\u2028\u2029]");

// Indents every line after the first so embedded line terminators in
// free-form comment text can never start a new line at column 0 -- the
// shape the stamp regex (`^- **<role>, <date>:**`) requires. Splitting on
// "\n" alone is not enough: a bare CR, U+2028 or U+2029 also counts as a
// line terminator for `^`/`$` in multiline mode, so any of those left
// unindented would still render as a second, forged attributed comment
// line on read-back.
function sanitizeCommentText(text) {
  return text
    .split(LINE_TERMINATOR_RE)
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join("\n");
}

function claimingRole(lockContent) {
  const token = lockContent.trim().split(/\s+/)[0];
  return token || "unknown";
}

// organism-infra/18: a claim lock's optional third token records the calling
// agent's `--mode` (e.g. `qa specify`), so `release` can tell a qa-specify
// claim apart from qa-verify or a plain claim with no mode. Undefined when no
// mode was given.
function claimingMode(lockContent) {
  return lockContent.trim().split(/\s+/)[2];
}

// organism-infra/18, ADR 0009 decisions 2 & 4, hardened after security's
// fix-1 bounce: `release --status in-review|resolved` must find a handoff
// bound to *the ticket being released*, not just newest-by-mtime across the
// whole feature. Two-stage filter:
//   1. Only filenames starting with the ticket's "NN-" prefix are considered
//      at all (handoffs live in `.scratch/<feature>/handoffs/*.md`, named
//      per the handoff skill's own `<NN>-<role>[-<n>].md` convention).
//   2. Among those, only a file whose parsed State block's `ticket` field
//      equals the ref being released -- either the full slug
//      (`<feature>/<ticket>`) or the short `<feature>/<NN>` form -- is a
//      candidate. mtime is only the tie-break *within* that set: this repo
//      runs every agent in a fresh git worktree, and `git checkout` resets
//      mtimes, so mtime alone is never a stable "most recent" signal.
// Refuses (no candidate) rather than falling back to some other file, so a
// release can never silently pass the gate on an unrelated or stale handoff.
async function validateHandoffState(root, feature, ticket, claim) {
  const handoffsDir = path.join(root, ".scratch", feature, "handoffs");
  const nnMatch = /^(\d{2,})-/.exec(ticket);
  const prefix = nnMatch ? `${nnMatch[1]}-` : null;
  const entries = await readdir(handoffsDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && prefix && e.name.startsWith(prefix))
    .map((e) => e.name);
  if (files.length === 0) {
    return {
      ok: false,
      errors: [
        `no handoff file found for ${feature}/${ticket} under ${handoffsDir} (expected a filename starting with "${prefix}")`,
      ],
    };
  }

  const fullRef = `${feature}/${ticket}`;
  const shortRef = `${feature}/${nnMatch[1]}`;
  const candidates = [];
  for (const name of files) {
    const p = path.join(handoffsDir, name);
    const s = await stat(p);
    const body = await readFile(p, "utf8");
    const match = /```json\s*([\s\S]*?)```/.exec(body);
    if (!match) continue;
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (parsed && (parsed.ticket === fullRef || parsed.ticket === shortRef)) {
      // organism-infra/35: the handoff must come from the releasing agent (and
      // mode), written after the current claim -- not an earlier hop's file.
      if (claim) {
        if (roleOf(parsed) !== claim.role) continue;
        if (claim.mode !== undefined && parsed.mode !== claim.mode) continue;
        if (claim.mtimeMs !== undefined && s.mtimeMs < claim.mtimeMs) continue;
      }
      candidates.push({ path: p, mtimeMs: s.mtimeMs, parsed });
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      errors: [
        `no handoff matching "${prefix}*.md" under ${handoffsDir} has a State block bound to "${fullRef}" (or "${shortRef}")` +
          (claim
            ? ` with role "${claim.role}"${claim.mode ? ` mode "${claim.mode}"` : ""}, written after the claim`
            : ""),
      ],
    };
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return validateState(candidates[0].parsed);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// --- Public operations -------------------------------------------------------------

async function prepare(root, ref) {
  const { feature, ticket } = parseTicketRef(ref);
  const paths = boardPaths(root, feature, ticket);
  await assertWithinRoot(root, paths.issuesDir);
  return { feature, ticket, paths };
}

// organism-infra/18 fix-1 (security HIGH #2): `--mode` is self-reported, so
// it must be constrained at the claim itself, not trusted later at release.
// An unrecognized mode string is rejected for every agent (not just qa), and
// a qa claim without `--mode` at all -- the exact gap the original incident
// (qa set in-review during a specify claim) exploited -- is rejected too.
const CLAIM_MODES = new Set(["specify", "verify"]);
// organism-infra/55: a designer claim names what it is doing.
const DESIGNER_MODES = new Set(["review", "spec", "critique", "direction"]);
export function modeAllowed(role, mode) {
  return CLAIM_MODES.has(mode) || (role === "designer" && DESIGNER_MODES.has(mode));
}

// organism-infra/24 security fix: identity is self-declared, but it must at
// least name a real agent, so it can never carry newlines or forged markup.
// team-and-den-ux/19: the chief of staff (Bao, Jiao) resolves tickets. "orchestrator" stays accepted for one release, as a stub.
const RESOLVER = "chief-of-staff";
const RESOLVERS = new Set([RESOLVER, "orchestrator"]);
const KNOWN_ROLES = new Set([
  "product", "architect", "chief-of-staff", "orchestrator", "developer", "scout",
  "qa", "security", "designer",
  // ADR 0029 (team-and-den-ux/02)
  "code-reviewer", "release-manager", "sre", "technical-writer",
]);

/** Is this a role the board can hold a ticket for? (den-mvp/23: a role it does not know runs unclaimed.) */
export const isBoardRole = (name) => typeof name === "string" && KNOWN_ROLES.has(name);

function checkKnownRole(name, what) {
  if (typeof name !== "string" || !KNOWN_ROLES.has(name)) {
    throw new BoardError(
      `invalid ${what}: ${JSON.stringify(name)} (allowed: ${[...KNOWN_ROLES].join(", ")})`
    );
  }
}

export async function claim(root, ref, role, options = {}) {
  const { mode } = options;
  checkArgLength(role, "role");
  checkKnownRole(role, "role");
  checkArgLength(mode, "mode");
  if (mode !== undefined && !modeAllowed(role, mode)) {
    throw new BoardError(
      `invalid mode: ${mode} (allowed: ${[...CLAIM_MODES, ...(role === "designer" ? DESIGNER_MODES : [])].join(", ")})`
    );
  }
  if (role === "qa" && mode === undefined) {
    throw new BoardError(
      `--mode is required for role "qa" (allowed: ${[...CLAIM_MODES].join(", ")})`
    );
  }
  const { feature, ticket, paths } = await prepare(root, ref);

  // A taken claim lock fails fast, without waiting on the write lock. It is
  // checked again under the write lock, which is the authoritative check.
  if (await exists(paths.claimLockPath)) {
    throw new BoardError(`ticket already claimed: ${ref}`);
  }

  return withWriteLock(paths.writeLockPath, async () => {
    await assertWithinRoot(root, paths.issuesDir);
    if (await exists(paths.claimLockPath)) {
      throw new BoardError(`ticket already claimed: ${ref}`);
    }
    if (!(await exists(paths.ticketPath))) {
      throw new BoardError(`ticket not found: ${ref}`);
    }
    // Read and validate before creating the claim lock, so a ticket with no
    // header status line is refused without leaving a lock behind.
    const content = await readFile(paths.ticketPath, "utf8");
    const fromStatus = readStatus(content);
    // organism-infra/28: review agents (security, qa verify) claiming an
    // in-review ticket leave it in-review while held; anyone else sets claimed.
    const keepInReview =
      fromStatus === "in-review" &&
      (role === "security" || (role === "qa" && (mode === "verify" || mode === "specify")));
    const newStatus = keepInReview ? "in-review" : "claimed";
    const updated = keepInReview ? content : replaceStatus(content, newStatus);
    // organism-infra/55: a qa specify claim remembers the status it displaced,
    // so release --keep-status can put it back instead of leaving `claimed`.
    const prior =
      role === "qa" && mode === "specify" && (fromStatus === "ready-for-agent" || fromStatus === "blocked")
        ? ` ${fromStatus}`
        : "";
    await commitWithEvent(paths.eventsPath, async () => {
      await writeFile(
        paths.claimLockPath,
        `${role} ${new Date().toISOString()}${mode ? ` ${mode}` : ""}${prior}\n`,
        { encoding: "utf8", flag: "wx" }
      );
      await atomicWrite(paths.ticketPath, updated);
    }, {
      feature,
      ticket,
      role,
      mode: mode ?? null,
      op: "claim",
      from_status: fromStatus,
      to_status: newStatus,
    });
    return { status: newStatus };
  });
}

// organism-infra/24: take over an existing claim lock in one command. Claim
// locks carry no pid, so "stale" is not decidable mechanically: any existing
// lock may be taken over. With no lock there is nothing to take over (use
// `claim`). The ticket status stays `claimed`.
export async function reclaim(root, ref, role, options = {}) {
  const { mode, reason } = options;
  checkArgLength(role, "role");
  checkKnownRole(role, "role");
  if (RESOLVERS.has(role)) {
    throw new BoardError(`reclaim as ${role} is refused (only the chief of staff may resolve; use claim on an unlocked ticket)`);
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new BoardError("reclaim requires --reason <text>");
  }
  checkArgLength(reason, "reason");
  checkArgLength(mode, "mode");
  if (mode !== undefined && !CLAIM_MODES.has(mode)) {
    throw new BoardError(`invalid mode: ${mode} (allowed: ${[...CLAIM_MODES].join(", ")})`);
  }
  if (role === "qa" && mode === undefined) {
    throw new BoardError(
      `--mode is required for role "qa" (allowed: ${[...CLAIM_MODES].join(", ")})`
    );
  }
  const { feature, ticket, paths } = await prepare(root, ref);

  return withWriteLock(paths.writeLockPath, async () => {
    await assertWithinRoot(root, paths.issuesDir);
    if (!(await exists(paths.claimLockPath))) {
      throw new BoardError(`nothing to reclaim: ${ref} has no claim lock (use claim)`);
    }
    const previous = claimingRole(await readFile(paths.claimLockPath, "utf8"));
    const content = await readFile(paths.ticketPath, "utf8");
    const status = readStatus(content);
    await commitWithEvent(paths.eventsPath, async () => {
      await atomicWrite(
        paths.claimLockPath,
        `${role} ${new Date().toISOString()}${mode ? ` ${mode}` : ""}\n`
      );
    }, {
      feature,
      ticket,
      role,
      mode: mode ?? null,
      op: "reclaim",
      reason,
      previous_role: previous,
      from_status: status,
      to_status: status,
    });
    return { status };
  });
}

// organism-infra/18: `--status in-review|resolved` is gated by ADR 0009
// decisions 2 and 4 -- a bad transition for the calling agent's mode (qa in
// `specify` mode never sets ticket status itself), and a missing/invalid
// handoff State block, are both hard-blocked unless `--force --reason "..."`
// is given. A forced release still writes the release, but also logs a
// `kind:"override"` events.jsonl line the orchestrator surfaces.
// organism-infra/30: the gate covers every status except `blocked`.

// organism-infra/48: the resolved row is scripted, not hand-written. Bounces are
// the ticket's comment events recorded with --verdict bounce.
function validatePrFlag(pr) {
  if (pr === undefined) return undefined;
  if (typeof pr !== "string" || !/^[1-9][0-9]{0,8}$/.test(pr)) {
    throw new BoardError(`invalid --pr: ${JSON.stringify(pr)} (must be a positive integer)`);
  }
  return Number(pr);
}

// organism-infra/49: append one line to usage.jsonl, refusing a symlink
// (O_NOFOLLOW) so a planted link cannot redirect the write.
export async function appendUsageLine(root, line) {
  await mkdir(path.join(root, ".scratch"), { recursive: true });
  const fh = await open(
    path.join(root, ".scratch", "usage.jsonl"),
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o644
  );
  try {
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

async function usageHasResolvedRow(root, ref) {
  const raw = await readFile(path.join(root, ".scratch", "usage.jsonl"), "utf8").catch(() => "");
  for (const l of raw.split("\n")) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (r.kind === "resolved" && r.ticket === ref) return true;
    } catch {}
  }
  return false;
}

// organism-infra/49: redo a lost resolved row (scripts/log-resolved.mjs).
export async function logResolved(root, ref, prArg) {
  const pr = validatePrFlag(prArg);
  const { feature, ticket, paths } = await prepare(root, ref);
  const content = await readFile(paths.ticketPath, "utf8").catch(() => {
    throw new BoardError(`ticket not found: ${ref}`);
  });
  if (readStatus(content) !== "resolved") throw new BoardError(`${ref} is not resolved; no row written`);
  const isCode = /^\*\*Type:\*\*[ \t]*(feature|bug)\b/m.test(content);
  if (isCode && pr === undefined) throw new BoardError(`${ref} is a code ticket; --pr <number> is required`);
  // organism-infra/50: the duplicate check and the append share the write lock.
  await withWriteLock(paths.writeLockPath, async () => {
    if (await usageHasResolvedRow(root, `${feature}/${ticket}`)) {
      throw new BoardError(`a resolved row for ${feature}/${ticket} already exists in usage.jsonl`);
    }
    await appendResolvedRow(root, paths.eventsPath, ref, pr ?? null);
  });
}

async function appendResolvedRow(root, eventsPath, ref, pr) {
  const { feature, ticket } = parseTicketRef(ref);
  const raw = await readFile(eventsPath, "utf8").catch(() => "");
  let bounces = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.op === "comment" && e.feature === feature && e.ticket === ticket && e.verdict === "bounce") bounces++;
  }
  const row = { kind: "resolved", ts: new Date().toISOString(), ticket: `${feature}/${ticket}`, pr, bounces };
  await appendUsageLine(root, JSON.stringify(row) + "\n");
}

// organism-infra/30: a filled-in State block for the rejection message, so a
// agent can fix a bad handoff in one retry. role/mode come from the claim lock.
function stateObject(feature, ticket, role, mode, pending = []) {
  const state = { ticket: `${feature}/${ticket}`, role: role ?? "<role>" };
  if (mode !== undefined) state.mode = mode;
  state.current_step = "<what is done and where the work stands>";
  state.artifacts = [];
  state.decisions = [];
  state.failures = [];
  state.pending = pending;
  return state;
}

function stateSkeleton(feature, ticket, role, mode) {
  const state = stateObject(feature, ticket, role, mode);
  return "\nExpected State block (copy, fill in, and retry):\n```json\n" + JSON.stringify(state, null, 2) + "\n```";
}

// organism-infra/66: `board handoff <ref> --template` prints a State block that
// already passes validateState. role/mode come from --role/--mode, else the claim lock.
export async function handoffTemplate(root, ref, options = {}) {
  const { feature, ticket, paths } = await prepare(root, ref);
  if (!(await exists(paths.ticketPath))) {
    throw new BoardError(`ticket not found: ${ref}`);
  }
  let { role, mode } = options;
  checkArgLength(role, "role");
  checkArgLength(mode, "mode");
  if (await exists(paths.claimLockPath)) {
    const lockContent = await readFile(paths.claimLockPath, "utf8");
    const lockRole = claimingRole(lockContent);
    if (role === undefined) role = lockRole;
    if (mode === undefined && role === lockRole) mode = claimingMode(lockContent);
  }
  if (role === undefined) {
    throw new BoardError(`no claim lock on ${ref}; pass --role <role> (and --mode <m> for a moded role)`);
  }
  checkKnownRole(role, "role");
  if (mode !== undefined && !modeAllowed(role, mode)) {
    throw new BoardError(`invalid mode: ${mode} for role "${role}"`);
  }
  const state = stateObject(feature, ticket, role, mode, [
    { item: "<work left for the next agent; empty this array if none>", owner: "<next role>" },
  ]);
  return "```json\n" + JSON.stringify(state, null, 2) + "\n```";
}

async function claimSkeleton(paths, feature, ticket) {
  let role;
  let mode;
  if (await exists(paths.claimLockPath)) {
    const lockContent = await readFile(paths.claimLockPath, "utf8");
    role = claimingRole(lockContent);
    mode = claimingMode(lockContent);
  }
  return stateSkeleton(feature, ticket, role, mode);
}

// organism-infra/158: push the releasing agent's branch to origin (upstream
// tracking) so work never stays on one machine. Runs from `cwd` (the agent's
// worktree). Skipped on a detached HEAD, on main (the end-of-session check
// owns main), and when the repo has no origin. A failed push throws, so the
// caller refuses the release before writing anything.
function pushBranchToOrigin(cwd, ref) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  let branch;
  try {
    branch = git(["symbolic-ref", "--short", "-q", "HEAD"]);
  } catch {
    return; // detached HEAD (or not a git repo): no branch to push
  }
  if (!branch || branch === "main") return;
  try {
    if (!git(["remote"]).split(/\s+/).includes("origin")) return;
  } catch {
    return;
  }
  try {
    git(["push", "-u", "origin", "HEAD"]);
  } catch (err) {
    const detail = String(err.stderr || err.message || err).trim();
    throw new BoardError(
      `release blocked: pushing branch ${branch} to origin failed, so ${ref} stays claimed. Fix the cause and release again.\n${detail}`
    );
  }
}

export async function release(root, ref, newStatus, reason, options = {}) {
  const { force, keepStatus } = options;
  const pr = validatePrFlag(options.pr);
  if (pr !== undefined && (keepStatus || newStatus !== "resolved")) {
    throw new BoardError("--pr is only valid when releasing with --status resolved");
  }
  checkArgLength(newStatus, "status");
  checkArgLength(reason, "reason");
  if (keepStatus && newStatus !== undefined) {
    throw new BoardError("--keep-status and --status are mutually exclusive");
  }
  if (!keepStatus && !STATUSES.includes(newStatus)) {
    throw new BoardError(`invalid status: ${newStatus}`);
  }
  if (force && !reason) {
    throw new BoardError("--force requires --reason");
  }
  const { feature, ticket, paths } = await prepare(root, ref);

  return withWriteLock(paths.writeLockPath, async () => {
    await assertWithinRoot(root, paths.issuesDir);
    let role = "unknown";
    let mode;
    let claimMtimeMs;
    let priorStatus;
    if (await exists(paths.claimLockPath)) {
      const lockContent = await readFile(paths.claimLockPath, "utf8");
      role = claimingRole(lockContent);
      mode = claimingMode(lockContent);
      const p = lockContent.trim().split(/\s+/)[3];
      if (p === "ready-for-agent" || p === "blocked") priorStatus = p;
      claimMtimeMs = (await stat(paths.claimLockPath)).mtimeMs;
    }

    // organism-infra/24: only a chief-of-staff claim may resolve a ticket.
    // Unlike the handoff check, --force does not bypass this rule.
    if (newStatus === "resolved" && !RESOLVERS.has(role)) {
      throw new BoardError(
        `invalid status transition: a claim held by ${role} cannot release ${ref} at resolved (only the chief of staff resolves)`
      );
    }

    if (newStatus !== "blocked") {
      // organism-infra/30: every release except blocked needs a handoff;
      // --keep-status runs the same handoff gate.
      // Ticket 18 only names `--force` as an override for the handoff
      // State-block check (item 3), never for this transition rule (item
      // 2). Security fix-1 (HIGH #2): a qa release to in-review is allowed
      // only for a *verify* claim -- allow-listing "specify" alone left any
      // other mode (including none, before claim required one) sail
      // through, which is the exact incident this ticket exists to close.
      if (role === "qa" && newStatus === "in-review" && mode !== "verify") {
        throw new BoardError(
          `invalid status transition: a claim held by qa in mode "${mode ?? "none"}" cannot release ${ref} at in-review` +
            ` (only a qa claim in "verify" mode may)`
        );
      }
      if (!force) {
        // organism-infra/45: no claim lock means no role/mode/age binding, so
        // a gated release without a claim is refused.
        if (claimMtimeMs === undefined) {
          throw new BoardError(
            `release blocked: ${ref} has no claim lock; claim it first (use --force --reason to override)`
          );
        }
        const handoffCheck = await validateHandoffState(root, feature, ticket, { role, mode, mtimeMs: claimMtimeMs });
        if (!handoffCheck.ok) {
          throw new BoardError(
            `release blocked: ${ref} has no valid handoff State block: ${handoffCheck.errors.join("; ")}` +
              ` (use --force --reason to override)` +
              stateSkeleton(feature, ticket, role === "unknown" ? undefined : role, mode)
          );
        }
      }
    }

    const content = await readFile(paths.ticketPath, "utf8");
    // organism-infra/48: a resolved release of a code ticket needs --pr. Checked
    // before any write so a refusal leaves the claim and appends no row.
    let resolvedPr = null;
    if (newStatus === "resolved") {
      const isCode = /^\*\*Type:\*\*[ \t]*(feature|bug)\b/m.test(content);
      if (isCode && pr === undefined) {
        throw new BoardError(`release blocked: ${ref} is a code ticket; --pr <number> is required to resolve it`);
      }
      resolvedPr = pr ?? null;
    }
    const fromStatus = readStatus(content);
    // --keep-status: free the lock and leave the status line untouched.
    // organism-infra/55: a qa specify lock carries the pre-claim status; restore it.
    const restore = keepStatus && role === "qa" && mode === "specify" && fromStatus === "claimed" ? priorStatus : undefined;
    const toStatus = restore ?? (keepStatus ? fromStatus : newStatus);
    let updated = restore ? replaceStatus(content, restore) : keepStatus ? content : replaceStatus(content, newStatus);
    if (reason) {
      updated = `${updated.trimEnd()}\n- **${role}, ${todayUTC()}:** ${reason}\n`;
    }
    // organism-infra/158: the push comes after every refusal check and before
    // any write, so a failed push leaves the claim, status and events untouched.
    if (options.pushFrom) pushBranchToOrigin(options.pushFrom, ref);
    const events = [
      {
        feature,
        ticket,
        role,
        op: "release",
        from_status: fromStatus,
        to_status: toStatus,
        force: Boolean(force),
      },
    ];
    // Only log an override when `--force` actually bypassed something (the
    // handoff-state check, gated on in-review/resolved): a force flag on an
    // ungated status has nothing to override and must not pollute the audit
    // trail with a spurious event.
    if (force && newStatus !== "blocked") {
      events.push({ feature, ticket, role, op: "release", kind: "override", reason });
    }
    await commitWithEvent(paths.eventsPath, async () => {
      await atomicWrite(paths.ticketPath, updated);
      await unlink(paths.claimLockPath).catch(() => {});
    }, events);
    if (newStatus === "resolved") {
      try {
        await appendResolvedRow(root, paths.eventsPath, ref, resolvedPr);
      } catch (err) {
        throw new BoardError(
          `${ref} is resolved, but the usage.jsonl resolved row was NOT written (${err.code ?? err.message}); ` +
            `redo it with: node scripts/log-resolved.mjs --ticket ${feature}/${ticket}${resolvedPr === null ? "" : ` --pr ${resolvedPr}`}`
        );
      }
    }
    return { status: toStatus };
  });
}

// organism-infra/30: publish a handoff an agent wrote locally (worktree or
// scratchpad) into <main>/.scratch/<feature>/handoffs/. The destination is
// always a plain filename inside that directory.
const HANDOFF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

const HANDOFF_MAX_BYTES = 256 * 1024;

function stateBlock(text) {
  const m = /```json\s*([\s\S]*?)```/.exec(text);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

function isWithin(dir, target) {
  const rel = path.relative(dir, target);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

// organism-infra/78: a draft left inside a worktree blocks `git worktree remove`,
// so --from may sit in no git working tree except under the main checkout's .scratch/.
async function refuseWorktreeDraft(root, fromFile, name) {
  const dir = await realpath(path.dirname(path.resolve(fromFile))).catch(() => null);
  if (!dir) return;
  let top;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
  const realTop = await realpath(top).catch(() => path.resolve(top));
  const realRoot = await realpath(root).catch(() => path.resolve(root));
  if (realTop === realRoot && isWithin(path.join(realRoot, ".scratch"), dir)) return;
  throw new BoardError(
    `--from ${fromFile} is inside the git worktree ${realTop}, and a draft left there blocks \`git worktree remove\`. ` +
      `Draft the handoff under /tmp (e.g. /tmp/${name}) and publish from there; nothing was published.`
  );
}

export async function publishHandoff(root, ref, fromFile, options = {}) {
  const { feature, ticket, paths } = await prepare(root, ref);
  if (!fromFile) throw new BoardError("handoff requires --from <file>");
  const name = options.name ?? path.basename(fromFile);
  if (!HANDOFF_NAME_RE.test(name) || name.includes("..")) {
    throw new BoardError(`invalid handoff name "${name}": must be a plain <name>.md filename`);
  }
  await refuseWorktreeDraft(root, fromFile, name);
  const namePrefix = /^(\d{2,})-/.exec(name);
  const ticketPrefix = /^(\d{2,})-/.exec(ticket);
  if (namePrefix && ticketPrefix && namePrefix[1] !== ticketPrefix[1]) {
    throw new BoardError(
      `handoff name "${name}" has prefix ${namePrefix[1]}- but ${ref} needs prefix ${ticketPrefix[1]}-`
    );
  }
  if (!(await exists(paths.issuesDir))) {
    throw new BoardError(`unknown feature: ${feature}`);
  }
  let body;
  try {
    const st = await lstat(fromFile);
    if (st.isSymbolicLink()) throw new BoardError(`--from must not be a symlink: ${fromFile}`);
    if (!st.isFile()) throw new BoardError(`--from must be a regular file: ${fromFile}`);
    if (st.size > HANDOFF_MAX_BYTES) {
      throw new BoardError(`--from file exceeds ${HANDOFF_MAX_BYTES} bytes: ${fromFile}`);
    }
    body = await readFile(fromFile, "utf8");
  } catch (err) {
    if (err instanceof BoardError) throw err;
    throw new BoardError(`cannot read --from file: ${fromFile}`);
  }
  if (Buffer.byteLength(body) > HANDOFF_MAX_BYTES) {
    throw new BoardError(`--from file exceeds ${HANDOFF_MAX_BYTES} bytes: ${fromFile}`);
  }
  const match = /```json\s*([\s\S]*?)```/.exec(body);
  let parsed;
  try {
    parsed = match && JSON.parse(match[1]);
  } catch {
    parsed = null;
  }
  const nn = /^(\d{2,})-/.exec(ticket)[1];
  if (!parsed || (parsed.ticket !== `${feature}/${ticket}` && parsed.ticket !== `${feature}/${nn}`)) {
    throw new BoardError(
      `handoff State block must name ticket ${feature}/${ticket}` + (await claimSkeleton(paths, feature, ticket))
    );
  }
  // organism-infra/51: fill role/mode from the claim lock when the block omits
  // them, then validate the whole block before anything is written.
  let lockRole;
  let lockMode;
  let lockMtimeMs;
  if (await exists(paths.claimLockPath)) {
    const lockContent = await readFile(paths.claimLockPath, "utf8");
    lockRole = claimingRole(lockContent);
    lockMode = claimingMode(lockContent);
    lockMtimeMs = (await stat(paths.claimLockPath)).mtimeMs;
  }
  let filled = false;
  if (lockRole !== undefined && (roleOf(parsed) == null)) {
    parsed.role = lockRole;
    filled = true;
  }
  if (lockRole !== undefined && roleOf(parsed) === lockRole && lockMode !== undefined && parsed.mode === undefined) {
    parsed.mode = lockMode;
    filled = true;
  }
  const verdict = validateState(parsed);
  if (!verdict.ok) {
    throw new BoardError(
      `handoff State block is invalid, nothing published:\n  - ${verdict.errors.join("\n  - ")}` +
        (await claimSkeleton(paths, feature, ticket))
    );
  }
  if (filled) {
    body = body.slice(0, match.index) + "```json\n" + JSON.stringify(parsed) + "\n```" + body.slice(match.index + match[0].length);
  }
  const dir = path.join(root, ".scratch", feature, "handoffs");
  await assertWithinRoot(root, dir);
  const dirStat = await lstat(dir).catch(() => null);
  if (dirStat && dirStat.isSymbolicLink()) throw new BoardError("handoffs directory must not be a symlink");
  await mkdir(dir, { recursive: true });
  await assertWithinRoot(root, dir);
  const dest = path.join(dir, name);
  if (path.dirname(dest) !== dir) throw new BoardError("handoff destination escapes the handoffs directory");
  const destStat = await lstat(dest).catch(() => null);
  if (destStat) {
    if (destStat.isSymbolicLink() || !destStat.isFile()) {
      throw new BoardError(`handoff destination is not a regular file: ${name}`);
    }
    const prior = stateBlock(await readFile(dest, "utf8").catch(() => ""));
    // organism-infra/51: the claim holder may replace a draft it published under
    // its own claim (file newer than the lock), whatever role/mode that draft named.
    const ownDraft = lockMtimeMs !== undefined && destStat.mtimeMs >= lockMtimeMs && roleOf(parsed) === lockRole;
    // organism-infra/62: with a claim lock, a file older than the lock came from
    // an earlier claim; never overwrite it, even when role/mode match.
    if (lockMtimeMs !== undefined && destStat.mtimeMs < lockMtimeMs) {
      throw new BoardError(`handoff ${name} was published under an earlier claim; refusing to overwrite`);
    }
    if (!ownDraft && (!prior || roleOf(prior) !== roleOf(parsed) || prior.mode !== parsed.mode)) {
      throw new BoardError(`handoff ${name} already exists from a different role/mode; refusing to overwrite`);
    }
  }
  await atomicWrite(dest, body);
  return { path: dest };
}

// organism-infra/98: `board resolve <ref>... --pr N [--note "<text>"]` runs the
// orchestrator's claim, handoff and resolved-release in one step. Every ref is
// checked before the first write, so a refusal on any of them changes none of
// them. A failure after writes began is reported with the refs already resolved
// and the ref it stopped on; the board never ends silently partial.
export async function resolve(root, refs, options = {}) {
  const { pr: prArg, note } = options;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new BoardError("resolve requires at least one ticket ref");
  }
  if (prArg === undefined) {
    throw new BoardError("resolve requires --pr <number> (the merged pull request)");
  }
  const pr = validatePrFlag(prArg);
  checkArgLength(note, "note");

  // Phase 1: validate everything, write nothing.
  const seen = new Set();
  const planned = [];
  for (const ref of refs) {
    const { feature, ticket, paths } = await prepare(root, ref);
    const full = `${feature}/${ticket}`;
    if (seen.has(full)) throw new BoardError(`resolve: ${full} is listed twice`);
    seen.add(full);
    if (!(await exists(paths.ticketPath))) throw new BoardError(`ticket not found: ${ref}`);
    if (await exists(paths.claimLockPath)) {
      const holder = claimingRole(await readFile(paths.claimLockPath, "utf8"));
      throw new BoardError(`resolve refused: ${full} is claimed by ${holder}; nothing was changed`);
    }
    const status = readStatus(await readFile(paths.ticketPath, "utf8"));
    if (status === "resolved") throw new BoardError(`resolve refused: ${full} is already resolved; nothing was changed`);
    planned.push({ ref, feature, ticket, paths, status });
  }

  // Phase 2: claim, handoff, release per ref.
  const draftDir = await mkdtemp(path.join(os.tmpdir(), "board-resolve-"));
  const done = [];
  try {
    for (const item of planned) {
      const { ref, feature, ticket, paths } = item;
      try {
        await claim(root, ref, RESOLVER);
        const nn = /^(\d{2,})-/.exec(ticket)[1];
        const state = {
          ticket: `${feature}/${ticket}`,
          role: RESOLVER,
          current_step: "resolved",
          artifacts: [`PR #${pr}`],
          decisions: [],
          failures: [],
          pending: [],
        };
        const body =
          "```json\n" + JSON.stringify(state, null, 2) + "\n```\n\n## Summary\n\n" +
          `Resolved by \`board resolve\` after PR #${pr} merged.\n` +
          (note ? `\n${sanitizeCommentText(note)}\n` : "");
        const dir = path.join(root, ".scratch", feature, "handoffs");
        let name = `${nn}-${RESOLVER}-resolve.md`;
        for (let n = 2; await exists(path.join(dir, name)); n++) name = `${nn}-${RESOLVER}-resolve-${n}.md`;
        const draft = path.join(draftDir, name);
        await writeFile(draft, body, "utf8");
        await publishHandoff(root, ref, draft, { name });
        await release(root, ref, "resolved", note ? sanitizeCommentText(note) : undefined, { pr: String(pr) });
        done.push(ref);
      } catch (err) {
        // Undo this ref's own claim when it never reached resolved. Only an
        // orchestrator lock is ours; another agent's lock is left untouched.
        let undone = "";
        const content = await readFile(paths.ticketPath, "utf8").catch(() => "");
        if (readStatus(content) === "resolved") {
          // release wrote resolved but a later step (the usage append) threw.
          if (!done.includes(ref)) done.push(ref);
        } else {
          const lockContent = await readFile(paths.claimLockPath, "utf8").catch(() => null);
          if (lockContent !== null) {
            const holder = claimingRole(lockContent);
            if (RESOLVERS.has(holder)) {
              try {
                await release(root, ref, item.status, "resolve failed; claim undone", { force: true });
                undone = `; ${ref} was put back to ${item.status}`;
              } catch (undoErr) {
                undone = `; could not undo the claim on ${ref} (${undoErr.message}); free it with board reclaim/release`;
              }
            } else {
              undone = `; ${ref} is held by ${holder}, so its lock was left untouched`;
            }
          }
        }
        const rest = planned.map((p) => p.ref).filter((r) => !done.includes(r) && r !== ref);
        throw new BoardError(
          `resolve stopped at ${ref}: ${err.message}${undone}. ` +
            `resolved: ${done.length ? done.join(", ") : "none"}; not attempted: ${rest.length ? rest.join(", ") : "none"}`
        );
      }
    }
  } finally {
    await rm(draftDir, { recursive: true, force: true });
  }
  return { resolved: done };
}

// Refocus 2026-10-02: tickets off the relay. `parked` waits for a reason to
// come back (unpark); `closed` will not be done. Neither is in STATUSES, so
// no agent can release into them and the frontier never picks them.
const OFF_RELAY = {
  park: { to: "parked", label: "Parked", from: (s) => s !== "resolved" && s !== "parked" },
  close: { to: "closed", label: "Closed", from: (s) => s !== "resolved" && s !== "closed" },
  unpark: { to: "ready-for-agent", label: "Unparked", from: (s) => s === "parked" },
  reopen: { to: "ready-for-agent", label: "Reopened", from: (s) => s === "closed" },
  // den-mvp/13: the user's approval of a ticket waiting at ready-for-human, from the den.
  approve: { to: "ready-for-agent", label: "Approved", from: (s) => s === "ready-for-human" },
};
export const OFF_RELAY_STATUSES = ["parked", "closed"];

export async function setOffRelay(root, refs, op, options = {}) {
  const spec = OFF_RELAY[op];
  if (!spec) throw new BoardError(`unknown op: ${op}`);
  const { reason } = options;
  if (!Array.isArray(refs) || refs.length === 0) throw new BoardError(`${op} requires at least one ticket ref`);
  if (!reason) throw new BoardError(`${op} requires --reason "<text>"`);
  checkArgLength(reason, "reason");

  // Phase 1: validate everything, write nothing.
  const seen = new Set();
  const planned = [];
  for (const ref of refs) {
    const { feature, ticket, paths } = await prepare(root, ref);
    const full = `${feature}/${ticket}`;
    if (seen.has(full)) throw new BoardError(`${op}: ${full} is listed twice`);
    seen.add(full);
    if (!(await exists(paths.ticketPath))) throw new BoardError(`ticket not found: ${ref}`);
    if (await exists(paths.claimLockPath)) {
      const holder = claimingRole(await readFile(paths.claimLockPath, "utf8"));
      throw new BoardError(`${op} refused: ${full} is claimed by ${holder}; nothing was changed`);
    }
    const status = readStatus(await readFile(paths.ticketPath, "utf8"));
    if (!spec.from(status)) throw new BoardError(`${op} refused: ${full} is ${status}; nothing was changed`);
    planned.push({ feature, ticket, paths, status });
  }

  // Phase 2: one status change, comment and event per ref.
  const done = [];
  for (const { feature, ticket, paths, status } of planned) {
    await withWriteLock(paths.writeLockPath, async () => {
      await assertWithinRoot(root, paths.issuesDir);
      const content = await readFile(paths.ticketPath, "utf8");
      const stamp = `- **${RESOLVER}, ${todayUTC()}:** ${spec.label}: ${sanitizeCommentText(reason)}`;
      const withStatus = replaceStatus(content, spec.to);
      const updated = /## Comments/.test(withStatus)
        ? `${withStatus.trimEnd()}\n${stamp}\n`
        : `${withStatus.trimEnd()}\n\n## Comments\n${stamp}\n`;
      await commitWithEvent(paths.eventsPath, () => atomicWrite(paths.ticketPath, updated), {
        feature,
        ticket,
        role: RESOLVER,
        op,
        from: status,
        to: spec.to,
        reason,
      });
    });
    done.push(`${feature}/${ticket}`);
  }
  return { done, status: spec.to };
}

export async function getStatus(root, ref) {
  const { paths } = await prepare(root, ref);
  if (!(await exists(paths.ticketPath))) {
    throw new BoardError(`ticket not found: ${ref}`);
  }
  const content = await readFile(paths.ticketPath, "utf8");
  return readStatus(content);
}

const VERDICT_ROLES = new Set(["code-reviewer", "qa", "security", "chief-of-staff", "orchestrator", "designer"]);

export async function comment(root, ref, text, options = {}) {
  const { as, verdict } = options;
  if (verdict !== undefined && verdict !== "pass" && verdict !== "bounce") {
    throw new BoardError(`invalid --verdict: ${JSON.stringify(verdict)} (allowed: pass, bounce)`);
  }
  checkArgLength(text, "comment");
  checkArgLength(as, "author");
  const { feature, ticket, paths } = await prepare(root, ref);

  return withWriteLock(paths.writeLockPath, async () => {
    // Re-verify containment at the actual write: the realpath check in
    // prepare() and the symlink it resolved can both be stale by the time we
    // reach here, since acquiring the write lock can mean sleeping through a
    // bounded wait. Re-checking right before touching the ticket closes that
    // check-then-write window.
    await assertWithinRoot(root, paths.issuesDir);
    // organism-infra/24: author is --as when given, else the claim lock's agent; with
    // neither the comment is rejected rather than stamped "unknown".
    let role = as;
    if (role !== undefined) checkKnownRole(role, "author");
    let lockMode;
    if (await exists(paths.claimLockPath)) {
      const lockContent = await readFile(paths.claimLockPath, "utf8");
      const lockRole = claimingRole(lockContent);
      lockMode = claimingMode(lockContent);
      if (role !== undefined && role !== lockRole) {
        throw new BoardError(
          `comment rejected: --as ${role} does not match the claim lock's role (${lockRole})`
        );
      }
      role = lockRole;
    }
    if (!role) {
      throw new BoardError(
        `comment rejected: no claim lock on ${ref} and no --as <role> to name the author`
      );
    }
    // organism-infra/50: a verdict needs the claim lock; a qa lock only in mode verify.
    if (verdict !== undefined && !(await exists(paths.claimLockPath))) {
      throw new BoardError(`comment rejected: --verdict needs a claim lock on ${ref} (claim it first)`);
    }
    if (verdict !== undefined && role === "qa" && lockMode !== "verify") {
      throw new BoardError("comment rejected: a qa verdict needs a claim lock held in mode verify");
    }
    if (verdict !== undefined && role === "designer" && lockMode !== "review") {
      throw new BoardError("comment rejected: a designer verdict needs a claim lock held in mode review");
    }
    if (verdict !== undefined && !VERDICT_ROLES.has(role)) {
      throw new BoardError(
        `comment rejected: --verdict is only accepted from qa, security, designer or chief-of-staff, not ${role}`
      );
    }
    const content = await readFile(paths.ticketPath, "utf8");
    const stamp = `- **${role}, ${todayUTC()}:** ${sanitizeCommentText(text)}`;
    let updated;
    if (/## Comments/.test(content)) {
      updated = `${content.trimEnd()}\n${stamp}\n`;
    } else {
      updated = `${content.trimEnd()}\n\n## Comments\n${stamp}\n`;
    }
    await commitWithEvent(paths.eventsPath, () => atomicWrite(paths.ticketPath, updated), {
      feature,
      ticket,
      role,
      op: "comment",
      text,
      ...(verdict ? { verdict } : {}),
    });
    return { ok: true };
  });
}

export async function list(root, { feature, status } = {}) {
  const { readdir } = await import("node:fs/promises");
  const scratchDir = path.join(root, ".scratch");
  const results = [];
  let features;
  if (feature) {
    checkArgLength(feature, "feature");
    if (!FEATURE_RE.test(feature)) {
      throw new BoardError(`invalid feature segment: ${feature}`);
    }
    features = [feature];
  } else {
    features = (await readdir(scratchDir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }
  for (const feat of features) {
    const issuesDir = path.join(scratchDir, feat, "issues");
    const entries = await readdir(issuesDir).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const ticket = entry.slice(0, -3);
      const content = await readFile(path.join(issuesDir, entry), "utf8").catch(() => "");
      const ticketStatus = readStatus(content);
      if (status && ticketStatus !== status) continue;
      results.push({ feature: feat, ticket, status: ticketStatus });
    }
  }
  return results;
}

// --- Create ---------------------------------------------------------------------

// den-v1 loop S1 (ADR 0016 amendment 9): the one place a ticket file is created by code. The number is the next free
// one in the feature, taken under a per-feature lock, and the file is created exclusively, so nothing is overwritten.
// `text` is its author's own words (the den's task box): every line is written inside a blockquote, with control
// characters replaced, so no line of it can start a header field, a section or an attributed comment.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9 -]{0,39}$/;
const PRIORITY_RE = /^P[0-3]$/;
const TITLE_MAX = 120;
// queue/03 (ADR 0015 Amendment 3): the machine header lines the admission gate reads.
export const TICKET_CLASSES = ["product", "pipeline"];
export const TICKET_ORIGINS = ["spec", "added"];
export const P0_REASONS = ["main-red", "relay-down", "security-high"];
const SERVES_MAX = 300;
// C0 and C1 controls, and the bidirectional marks and overrides (200e, 200f, 202a to 202e, 2066 to 2069).
const CONTROL_SRC = `[\\x00-\\x1f\\x7f-\\x9f${[0x200e, 0x200f].map((n) => String.fromCharCode(n)).join("")}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`;
const CONTROL_RE = new RegExp(CONTROL_SRC);
const CONTROL_ALL_RE = new RegExp(CONTROL_SRC, "g");

function quoteLines(text) {
  return text
    .split(LINE_TERMINATOR_RE)
    .map((line) => `> ${line.replace(CONTROL_ALL_RE, " ")}`.trimEnd())
    .join("\n");
}

// den-mvp outcome 4: `type` and `status` let the bridge write a ticket that is not work for an agent yet: a meeting's
// discussion ticket, and the work a chosen option proposes, both start at ready-for-human.
const CREATE_STATUSES = ["ready-for-agent", "ready-for-human"];
const TYPE_RE = /^[a-z][a-z -]{0,39}$/;
// den-mvp/55: a drafted ticket (form "ticket") is written as given, so it may not hold what only the board writes: a header
// field, a top heading or a Comments section. It must carry its own acceptance criteria.
const DRAFT_FORGERY_RE = /^[ \t>]*(?:\*\*\s*(?:Type|Priority|Status|Blocked by|Source|Class|Origin|Serves|Goal|P0-reason)\s*:|#\s|#{1,6}\s*Comments\b)/im;
const DRAFT_CRITERIA_RE = /^## Acceptance criteria[ \t]*$/m;
const FULL_REF_RE = /^[a-z0-9-]+\/\d+(?:-[a-z0-9-]+)?$/;
const BLOCKERS_MAX = 12;

function existingRef(root, ref) {
  if (typeof ref !== "string" || !FULL_REF_RE.test(ref)) throw new BoardError(`a blocker must be a ticket ref such as den-mvp/02: ${ref}`);
  const full = resolveShortRef(root, ref);
  const [feature, ticket] = full.split("/");
  if (!existsSync(path.join(root, ".scratch", feature, "issues", `${ticket}.md`))) throw new BoardError(`ticket not found: ${ref}`);
  return full;
}

export async function createTicket(root, { feature, slug, title, text, source, priority = "P2", class: ticketClass, origin, serves, goal, p0Reason, type = "task", status = "ready-for-agent", form = "request", blockedBy } = {}) {
  for (const [value, name] of [[feature, "feature"], [slug, "slug"], [title, "title"], [source, "source"], [serves, "serves"], [goal, "goal"], [p0Reason, "p0 reason"]]) {
    checkArgLength(value, name);
  }
  if (typeof text === "string" && text.length > TICKET_TEXT_MAX) throw new BoardError(`text exceeds the maximum length of ${TICKET_TEXT_MAX}`);
  if (typeof feature !== "string" || !FEATURE_RE.test(feature)) throw new BoardError(`invalid feature segment: ${feature}`);
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new BoardError(`invalid ticket slug: ${slug}`);
  if (typeof title !== "string" || !title.trim() || title.length > TITLE_MAX || LINE_TERMINATOR_RE.test(title) || CONTROL_RE.test(title)) {
    throw new BoardError(`title must be one line of at most ${TITLE_MAX} characters`);
  }
  if (typeof text !== "string" || !text.trim()) throw new BoardError("text must be a non-empty string");
  if (typeof priority !== "string" || !PRIORITY_RE.test(priority)) throw new BoardError(`invalid priority: ${priority}`);
  if (typeof type !== "string" || !TYPE_RE.test(type)) throw new BoardError("invalid type");
  if (!CREATE_STATUSES.includes(status)) throw new BoardError(`a ticket is created at one of: ${CREATE_STATUSES.join(", ")}`);
  if (source !== undefined && (typeof source !== "string" || !SOURCE_RE.test(source))) throw new BoardError("invalid source");
  if (ticketClass !== undefined && !TICKET_CLASSES.includes(ticketClass)) throw new BoardError(`invalid class: ${ticketClass} (product or pipeline)`);
  if (origin !== undefined && !TICKET_ORIGINS.includes(origin)) throw new BoardError(`invalid origin: ${origin} (spec or added)`);
  if (serves !== undefined) {
    // One header line: a newline or control character in it could start a second header field.
    if (typeof serves !== "string" || !serves.trim() || serves.length > SERVES_MAX || LINE_TERMINATOR_RE.test(serves) || CONTROL_RE.test(serves)) {
      throw new BoardError(`serves must be one line of at most ${SERVES_MAX} characters`);
    }
  }
  // den-mvp/61: a goal is checked against the user's goals file whenever one is given.
  if (goal !== undefined) {
    const problem = goalProblem(root, goal);
    if (problem) throw new BoardError(problem);
  }
  if (priority === "P0") {
    if (!P0_REASONS.includes(p0Reason)) throw new BoardError(`a P0 ticket needs --p0-reason ${P0_REASONS.join("|")}`);
  } else if (p0Reason !== undefined) {
    throw new BoardError("p0 reason only applies to a P0 ticket");
  }
  const originLine = origin ?? (ticketClass !== undefined ? "added" : undefined);
  if (form !== "request" && form !== "ticket") throw new BoardError("form must be request or ticket");
  if (form === "request" && blockedBy !== undefined) throw new BoardError("Blocked by is for drafted tickets (form ticket)");
  let blockers = [];
  if (form === "ticket") {
    if (!DRAFT_CRITERIA_RE.test(text)) throw new BoardError("a drafted ticket needs its own ## Acceptance criteria section");
    if (DRAFT_FORGERY_RE.test(text)) throw new BoardError("a drafted ticket's text cannot hold a header field, a top heading or a Comments section");
    // An unclosed fence would swallow the Comments section the board appends, in any rendered view.
    if ((text.match(/^[ \t]*(?:```|~~~)/gm) ?? []).length % 2 !== 0) throw new BoardError("a drafted ticket's text has an unclosed code fence");
    if (blockedBy !== undefined && !(Array.isArray(blockedBy) && blockedBy.length <= BLOCKERS_MAX)) throw new BoardError(`blockedBy must be a list of at most ${BLOCKERS_MAX} ticket refs`);
    blockers = [...new Set((blockedBy ?? []).map((ref) => existingRef(root, ref)))];
  }

  const issuesDir = path.join(root, ".scratch", feature, "issues");
  await assertWithinRoot(root, issuesDir);
  await mkdir(issuesDir, { recursive: true });
  return withWriteLock(path.join(issuesDir, "_create.write-lock.json"), async () => {
    const taken = (await readdir(issuesDir)).map((name) => /^(\d+)-[a-z0-9-]+\.md$/.exec(name)).filter(Boolean).map((m) => Number(m[1]));
    const nn = String(Math.max(0, ...taken) + 1).padStart(2, "0");
    const ticket = `${nn}-${slug}`;
    const paths = boardPaths(root, feature, ticket);
    const content = [
      `# ${nn}: ${title}`, "",
      `**Type:** ${type}`, "",
      `**Priority:** ${priority}`, "",
      `**Status:** ${status}`, "",
      ...(source ? [`**Source:** ${source}`, ""] : []),
      ...(ticketClass ? [`**Class:** ${ticketClass}`, ""] : []),
      ...(originLine ? [`**Origin:** ${originLine}`, ""] : []),
      ...(serves ? [`**Serves:** ${serves.trim()}`, ""] : []),
      ...(goal ? [`**Goal:** ${goal}`, ""] : []),
      ...(priority === "P0" ? [`**P0-reason:** ${p0Reason}`, ""] : []),
      ...(form === "ticket" ? [
        `**Blocked by:** ${blockers.length ? blockers.join(", ") : "none"}`, "",
        text.trim(), "",
      ] : [
        "## What to build", "",
        "The request, quoted as its author wrote it:", "",
        quoteLines(text.trim()), "",
        "## Acceptance criteria", "",
        "- [ ] The request above is done or answered, and the final reply says what was done.", "",
      ]),
      "## Comments", "",
    ].join("\n");
    await commitWithEvent(paths.eventsPath, () => createExclusive(paths.ticketPath, content), {
      feature, ticket, role: null, mode: null, op: "create", from_status: null, to_status: status,
    });
    return { ref: `${feature}/${ticket}`, feature, ticket, path: paths.ticketPath };
  });
}
