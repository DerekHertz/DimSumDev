// Friction F19, hardening/17: the den reads plan usage from the snapshot the status line writes
// (~/.claude/usage-cache.json). A snapshot older than STALE_MS is "unknown", never the old number; scripts/usage.mjs
// starts only when there is no snapshot file at all (a headless box), at most once per STALE_MS.
// A usage.jsonl row still wins when it is newer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUsageReading, newerUsage, STALE_MS } from "./usage-reading.mjs";

const T = Date.parse("2026-10-15T15:00:00Z");
async function cache(at) {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "den-usage-")), "usage-cache.json");
  await writeFile(file, JSON.stringify({ at, windows: { "5-hour": { percent: 26 }, weekly: { percent: 28 } }, cooldown_until: 0 }));
  return file;
}

test("the stale limit is five minutes", () => {
  assert.equal(STALE_MS, 5 * 60_000);
});

test("17-AC2 fresh: a snapshot inside the limit is the reading, and nothing is started", async () => {
  let refreshed = 0;
  const read = createUsageReading({ cacheFile: await cache(T - 60_000), refresh: () => refreshed++, now: () => T });
  assert.deepEqual(read(), { fiveHour: 26, weekly: 28, sampledAt: new Date(T - 60_000).toISOString() });
  assert.equal(refreshed, 0);
});

test("17-AC2 stale: a snapshot past the limit is unknown, not the old number, and usage.mjs is not started", async () => {
  let refreshed = 0;
  let now = T;
  const at = T - STALE_MS - 1;
  const read = createUsageReading({ cacheFile: await cache(at), refresh: () => refreshed++, now: () => now });
  const sampledAt = new Date(at).toISOString();
  assert.deepEqual(read(), { fiveHour: null, weekly: null, sampledAt, stale: true });
  now += 9 * 3600_000;
  assert.equal(read().fiveHour, null);
  assert.equal(refreshed, 0);
});

test("17-AC2 the limit itself is still fresh", async () => {
  const read = createUsageReading({ cacheFile: await cache(T - STALE_MS), refresh: () => {}, now: () => T });
  assert.equal(read().fiveHour, 26);
});

test("17-AC2 missing: no snapshot is no reading, and usage.mjs starts once per STALE_MS however often it is read", () => {
  let refreshed = 0;
  let now = T;
  const read = createUsageReading({ cacheFile: path.join(tmpdir(), "no-such-dir-den", "usage-cache.json"), refresh: () => refreshed++, now: () => now });
  assert.equal(read(), null);
  read();
  read();
  assert.equal(refreshed, 1);
  now += STALE_MS + 1;
  read();
  assert.equal(refreshed, 2);
});

test("17-AC2 an unparseable or unreadable snapshot counts as missing and starts usage.mjs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "den-usage-"));
  const corrupt = path.join(dir, "corrupt.json");
  await writeFile(corrupt, "{ not json");
  for (const cacheFile of [corrupt, dir]) {
    let refreshed = 0;
    const read = createUsageReading({ cacheFile, refresh: () => refreshed++, now: () => T });
    assert.equal(read(), null);
    assert.equal(refreshed, 1, cacheFile);
  }
});

test("17-AC2 a snapshot with a timestamp but no five-hour window is no reading and starts nothing (the status line never saw one)", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "den-usage-")), "usage-cache.json");
  await writeFile(file, JSON.stringify({ at: T - 1000, windows: { weekly: { percent: 28 } }, cooldown_until: 0 }));
  let refreshed = 0;
  const read = createUsageReading({ cacheFile: file, refresh: () => refreshed++, now: () => T });
  assert.equal(read(), null);
  assert.equal(refreshed, 0);
});

test("17-AC2 a stale reading does not carry an old row's number: the newer of row and snapshot wins, and unknown beats an older row", () => {
  const row = { fiveHour: 21, weekly: 46, sampledAt: "2026-10-12T21:46:33Z" };
  const unknown = { fiveHour: null, weekly: null, sampledAt: "2026-10-15T14:50:00.000Z", stale: true };
  assert.equal(newerUsage(row, unknown), unknown);
  assert.equal(newerUsage(unknown, row), unknown);
});

test("the newer reading wins", () => {
  const row = { fiveHour: 21, weekly: 46, sampledAt: "2026-10-12T21:46:33Z" };
  const live = { fiveHour: 26, weekly: 28, sampledAt: "2026-10-15T14:55:00.000Z" };
  assert.equal(newerUsage(row, live), live);
  assert.equal(newerUsage(live, row), live);
  assert.equal(newerUsage(null, live), live);
  assert.equal(newerUsage(row, null), row);
});
