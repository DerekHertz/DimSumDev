// dimsumden-ui-v0/02: priority module; queue/06 drops the aging bump. Seam: two pure functions exported
// from priority.mjs (ADR 0011 decision 3, "frontier").
//   parsePriority(ticketMarkdown) -> "P0" | "P1" | "P2" | "P3"
//   orderFrontier(candidates, handoffTimestamps)
//     candidates: [{ ref, priority, readySince }]  (readySince: ISO string)
//     handoffTimestamps: ISO strings, one per orchestrator handoff file (still accepted, no longer used)
//     -> [{ ref, priority, effectivePriority, bumps, bumped }] in frontier order
// Rules under test (queue/06, ADR 0015 Amendment 3: the Queue replaces the aging bump): a ticket is never
// bumped, however many handoffs came after its readySince: effectivePriority equals priority, bumps is 0
// and bumped is false. The UI snapshot still reads those fields. Order is priority, then readySince
// (oldest first), then ticket number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePriority, orderFrontier } from "./priority.mjs";

const doc = (line) => `# 02: Some ticket\n\n**Type:** feature\n\n${line}\n\n**Status:** ready-for-agent\n`;

// Parse table: [name, markdown, expected]
const PARSE_TABLE = [
  ["P0", doc("**Priority:** P0"), "P0"],
  ["P1", doc("**Priority:** P1"), "P1"],
  ["P2", doc("**Priority:** P2"), "P2"],
  ["P3", doc("**Priority:** P3"), "P3"],
  ["missing line is P2", "# 02: t\n\n**Type:** feature\n\n**Status:** ready-for-agent\n", "P2"],
  ["empty document is P2", "", "P2"],
  ["out-of-range level P4 is P2", doc("**Priority:** P4"), "P2"],
  ["out-of-range level P9 is P2", doc("**Priority:** P9"), "P2"],
  ["word instead of level is P2", doc("**Priority:** urgent"), "P2"],
  ["empty value is P2", doc("**Priority:** "), "P2"],
  ["bare P without digit is P2", doc("**Priority:** P"), "P2"],
  ["unbolded label is not a priority line", doc("Priority: P0"), "P2"],
];
for (const [name, md, want] of PARSE_TABLE) {
  test(`parsePriority: ${name}`, () => {
    assert.equal(parsePriority(md), want);
  });
}

test("parsePriority: a Priority mention in the body does not override the header line", () => {
  const md = `# 02: t\n\n**Priority:** P1\n\n**Status:** ready-for-agent\n\n## Comments\n\n- raise to **Priority:** P0 someday\n`;
  assert.equal(parsePriority(md), "P1");
});

// No aging (queue/06). Ticket ready at T0; handoff timestamps relative to it.
const T0 = "2026-09-28T00:00:00.000Z";
const after = (n) => Array.from({ length: n }, (_, i) => `2026-09-28T0${i + 1}:00:00.000Z`);
const one = (priority, handoffs, readySince = T0) =>
  orderFrontier([{ ref: "f/01-a", priority, readySince }], handoffs)[0];

test("no aging: 3 handoffs after readySince no longer lift P2 to P1", () => {
  assert.deepEqual(one("P2", after(3)), {
    ref: "f/01-a", priority: "P2", effectivePriority: "P2", bumps: 0, bumped: false,
  });
});

test("no aging: many handoffs leave every level where it is", () => {
  for (const level of ["P0", "P1", "P2", "P3"]) {
    for (const n of [0, 2, 3, 6, 9]) {
      assert.deepEqual(one(level, after(n)), {
        ref: "f/01-a", priority: level, effectivePriority: level, bumps: 0, bumped: false,
      }, `${level} after ${n} handoffs`);
    }
  }
});

// Frontier order.
const ISO = (h) => `2026-09-28T${String(h).padStart(2, "0")}:00:00.000Z`;

test("frontier order: priority, then oldest readySince, then ticket number", () => {
  const candidates = [
    { ref: "f/09-late-p2", priority: "P2", readySince: ISO(9) },
    { ref: "f/05-p3", priority: "P3", readySince: ISO(1) },
    { ref: "f/12-p0", priority: "P0", readySince: ISO(8) },
    { ref: "f/07-old-p2", priority: "P2", readySince: ISO(2) },
    { ref: "f/03-tie-b", priority: "P1", readySince: ISO(4) },
    { ref: "f/02-tie-a", priority: "P1", readySince: ISO(4) },
    { ref: "f/10-tie-c", priority: "P1", readySince: ISO(4) },
  ];
  const out = orderFrontier(candidates, []);
  assert.deepEqual(out.map((r) => r.ref), [
    "f/12-p0",
    "f/02-tie-a", // equal age: number 02 before 03 before 10 (numeric, not lexical)
    "f/03-tie-b",
    "f/10-tie-c",
    "f/07-old-p2",
    "f/09-late-p2",
    "f/05-p3",
  ]);
});

test("frontier order: numbers compare numerically across features", () => {
  const out = orderFrontier(
    [
      { ref: "b/100-x", priority: "P2", readySince: ISO(1) },
      { ref: "a/20-y", priority: "P2", readySince: ISO(1) },
    ],
    [],
  );
  assert.deepEqual(out.map((r) => r.ref), ["a/20-y", "b/100-x"]);
});

test("frontier order: equal age orders 99 before 100 whatever the input order", () => {
  const a = { ref: "f/99-a", priority: "P2", readySince: ISO(1) };
  const b = { ref: "f/100-b", priority: "P2", readySince: ISO(1) };
  assert.deepEqual(orderFrontier([a, b], []).map((r) => r.ref), ["f/99-a", "f/100-b"]);
  assert.deepEqual(orderFrontier([b, a], []).map((r) => r.ref), ["f/99-a", "f/100-b"]);
});

test("frontier order: an old P3 does not outrank a fresh P2, whatever the handoffs say", () => {
  const out = orderFrontier(
    [
      { ref: "f/02-fresh-p2", priority: "P2", readySince: ISO(20) },
      { ref: "f/01-old-p3", priority: "P3", readySince: ISO(1) },
    ],
    [ISO(2), ISO(3), ISO(4), ISO(5), ISO(6), ISO(7)],
  );
  assert.deepEqual(out.map((r) => [r.ref, r.effectivePriority, r.bumped]), [
    ["f/02-fresh-p2", "P2", false],
    ["f/01-old-p3", "P3", false],
  ]);
});

test("frontier order: an old P1 does not tie with a P0, so the P0 leads even when younger", () => {
  const out = orderFrontier(
    [
      { ref: "f/01-p1", priority: "P1", readySince: ISO(1) },
      { ref: "f/02-p0", priority: "P0", readySince: ISO(23) },
    ],
    [ISO(2), ISO(3), ISO(4)],
  );
  assert.deepEqual(out.map((r) => r.ref), ["f/02-p0", "f/01-p1"]);
  assert.equal(out[1].effectivePriority, "P1");
});

test("frontier order: empty input gives an empty list and does not mutate its input", () => {
  assert.deepEqual(orderFrontier([], []), []);
  const input = [
    { ref: "f/02-b", priority: "P3", readySince: ISO(1) },
    { ref: "f/01-a", priority: "P0", readySince: ISO(1) },
  ];
  const copy = structuredClone(input);
  orderFrontier(input, []);
  assert.deepEqual(input, copy);
});
