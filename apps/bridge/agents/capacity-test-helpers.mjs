// organism-infra/226 + 227 (batch): shared helpers for the capacity tests. Not a test file (no .test.mjs suffix).
//
// PINNED INTERFACE (qa specify; ADR 0016 amendment 14 and ADR 0011 decision 3 as amended 2026-10-12):
//   apps/bridge/agents/capacity.mjs  export capacity({ liveRefs, lockedRefs, max, cap }) -> { max, cap, load, live, room, refs }
//     load  = distinct refs in liveRefs or lockedRefs        live = liveRefs.length (host agents)
//     room  = max(0, min(max - load, cap - live))
//     refs  = one entry per distinct load ref, { ref, kind }, kind "live" when the ref is in liveRefs (a host agent that
//             also holds its ticket's lock is one "live" entry), else "lock". Order is not pinned.
//     The ADR says only that `refs` tells a live agent from a lock; the { ref, kind } shape is qa's pin (see the handoff).
//   createHost({ ..., lockedRefs: () => Promise<string[]> })  read once per admission, before the synchronous step
//   GET /state and the SSE snapshot carry a top-level `capacity` with exactly that shape.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { FEATURE } from "../bridge-fixture.mjs";

export const LOCK_TS = "2026-09-29T06:00:00.000Z";

// A missing module is the feature being absent, so say that instead of a bare import error.
export async function loadCapacity() {
  let mod;
  try {
    mod = await import("./capacity.mjs");
  } catch (err) {
    assert.fail(`apps/bridge/agents/capacity.mjs does not exist yet (missing feature): ${err.message}`);
  }
  assert.equal(typeof mod.capacity, "function", "capacity.mjs must export capacity()");
  return mod;
}

// A claim lock held by an agent the bridge did not start: the lock file beside an existing fixture ticket (`07-bumpable`).
export const lockTicket = (root, name, role = "developer") =>
  writeFile(path.join(root, ".scratch", FEATURE, "issues", `${name}.lock`), `${role} ${LOCK_TS}\n`);
export const withLocks = (...names) => async (root) => {
  for (const n of names) await lockTicket(root, n);
};

export const refOf = (name) => `${FEATURE}/${name}`;
// The kinds of the capacity.refs entries, as { ref: kind }.
export const kinds = (refs) => Object.fromEntries(refs.map((r) => [r.ref, r.kind]));
