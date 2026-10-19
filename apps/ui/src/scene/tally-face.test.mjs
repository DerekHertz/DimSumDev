// den-scene-v1/05: the Tally abacus view-model. Pure: no three, React or DOM.
// Contract under test (tally-face.mjs):
//   TALLY_LABEL, TALLY_ARIA_LABEL, TALLY_RODS_CAPTION, BEAD_SLIDE_MS
//   beadCount(value, scale)                       -> integer 0..10
//   tallyRods(usage, dashboardModel, nowMs)       -> { rods, caption, sampledText }
//     rod = { id, label, kind: "usage"|"metric", counted, color, valueText, statusText, mark80, ariaLabel, valueNow }
//     color is a design-token name: "qi" | "station-steamers" | "alarm"
//   beadSlide(prevCounted, nextCounted, { reducedMotion }) -> { animate, durationMs }
//   abacusLayout()                                -> { rodYs, labelColumnRight, beadSpan, mark80X, beadX(counted) }
//     frame-local units, origin at the frame centre, +x right, +y up.
// Expected values are hand-worked literals from the designer spec (handoffs/05-designer-spec.md), not
// recomputed from the module.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TALLY_LABEL,
  TALLY_ARIA_LABEL,
  TALLY_RODS_CAPTION,
  BEAD_SLIDE_MS,
  beadCount,
  tallyRods,
  beadSlide,
  abacusLayout,
} from "./tally-face.mjs";
import { dashboardModel } from "../panel/dashboard-model.mjs";

const NOW = Date.parse("2026-10-01T06:00:00.000Z");
const usage = (fiveHour, weekly = 41, minutesAgo = 12) => ({
  fiveHour,
  weekly,
  sampledAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
});
const windows = (...resolved) => resolved.map((r, i) => ({ start: `2026-09-30T0${i}:00:00Z`, resolved: r }));
const metrics = (over = {}) => ({
  throughput: { windows: windows(3, 6) }, // latest window resolved 6
  tokensByRole: { developer: { perTicket: 120000 }, qa: { perTicket: 48000 } }, // mean 84000
  incidentsByTool: { Bash: { perTicket: 0.2 }, Read: { perTicket: 0.1 } }, // sum 0.3
  ...over,
});
const rods = (u, m = metrics(), opts) => tallyRods(u, dashboardModel(m, opts), NOW);
const byId = (r) => Object.fromEntries(r.rods.map((x) => [x.id, x]));

test("Tally keeps its label and an accessible name that says it opens the dashboard", () => {
  assert.equal(TALLY_LABEL, "Tally");
  assert.equal(TALLY_ARIA_LABEL, "Tally: open the dashboard");
});

test("five rods in order: 5 h, Week, Served, Tokens, Spills", () => {
  const r = rods(usage(79));
  assert.deepEqual(r.rods.map((x) => x.label), ["5 h", "Week", "Served", "Tokens", "Spills"]);
  assert.deepEqual(r.rods.map((x) => x.id), ["five-hour", "week", "served", "tokens", "spills"]);
  assert.deepEqual(r.rods.map((x) => x.kind), ["usage", "usage", "metric", "metric", "metric"]);
});

test("counted beads = round(value / scale x 10), clamped to 0..10, with 0 and 100% fixtures", () => {
  const cases = [
    [0, 100, 0],
    [100, 100, 10],
    [79, 100, 8], // 7.9
    [41, 100, 4], // 4.1
    [14, 100, 1], // 1.4
    [26, 100, 3], // 2.6
    [96, 100, 10], // 9.6
    [6, 10, 6], // Served: 1 bead per ticket
    [84000, 200000, 4], // Tokens: 4.2
    [0.3, 1, 3], // Spills: 3.0
    [25, 10, 10], // over scale clamps
    [105, 100, 10],
    [-3, 100, 0], // negative clamps
    [Number.NaN, 100, 0],
  ];
  for (const [value, scale, want] of cases) assert.equal(beadCount(value, scale), want, `beadCount(${value}, ${scale})`);
});

test("the five rods carry the worked fixture counts: 5 h 79 -> 8, Week 41 -> 4, Served 6 -> 6, Tokens 84k -> 4, Spills 0.3 -> 3", () => {
  const m = byId(rods(usage(79, 41)));
  assert.deepEqual(
    ["five-hour", "week", "served", "tokens", "spills"].map((id) => m[id].counted),
    [8, 4, 6, 4, 3],
  );
});

test("usage rods at 0 and 100 percent count 0 and 10 beads", () => {
  const low = byId(rods(usage(0, 0)));
  assert.equal(low["five-hour"].counted, 0);
  assert.equal(low.week.counted, 0);
  const full = byId(rods(usage(100, 100)));
  assert.equal(full["five-hour"].counted, 10);
  assert.equal(full.week.counted, 10);
});

test("Served, Tokens and Spills use the designer's scales: 10 tickets, 200k per ticket, 1.0 per ticket", () => {
  const m = byId(rods(usage(10), metrics({ throughput: { windows: windows(9, 5) } })));
  assert.equal(m.served.counted, 5, "Served: latest window 5 of 10 tickets");
  const t = byId(rods(usage(10), metrics({ tokensByRole: { developer: { perTicket: 100000 }, qa: { perTicket: 100000 }, scout: { perTicket: 100000 } } })));
  assert.equal(t.tokens.counted, 5, "Tokens: mean 100k of 200k");
  const s = byId(rods(usage(10), metrics({ incidentsByTool: { Bash: { perTicket: 0.4 }, Read: { perTicket: 0.3 }, Edit: { perTicket: 0.3 } } })));
  assert.equal(s.spills.counted, 10, "Spills: summed 1.0 of 1.0");
});

test("value text: usage as a percent, Served in tickets, Tokens reuse the k format, Spills per ticket (sum is float-safe)", () => {
  const m = byId(rods(usage(79, 41)));
  assert.equal(m["five-hour"].valueText, "79%");
  assert.equal(m.week.valueText, "41%");
  assert.equal(m.served.valueText, "6 tickets");
  assert.equal(m.tokens.valueText, "84k / ticket");
  assert.equal(m.spills.valueText, "0.3 / ticket", "0.2 + 0.1 must not print as 0.30000000000000004");
  const one = byId(rods(usage(79), metrics({ throughput: { windows: windows(4, 1) } })));
  assert.equal(one.served.valueText, "1 ticket");
  const none = byId(rods(usage(79), metrics({ throughput: { windows: windows(4, 0) } })));
  assert.equal(none.served.valueText, "0 tickets");
  assert.equal(none.served.counted, 0);
});

test("bead colours: qi for 5 h, Week and Served; station-steamers for Tokens; alarm for Spills", () => {
  const m = byId(rods(usage(79, 41)));
  assert.equal(m["five-hour"].color, "qi");
  assert.equal(m.week.color, "qi");
  assert.equal(m.served.color, "qi");
  assert.equal(m.tokens.color, "station-steamers");
  assert.equal(m.spills.color, "alarm");
});

test("usage rods past 95 percent turn their counted beads alarm; 95 itself stays qi; other rods are unaffected", () => {
  const hot = byId(rods(usage(96, 41)));
  assert.equal(hot["five-hour"].color, "alarm");
  assert.equal(hot["five-hour"].counted, 10);
  assert.equal(hot.week.color, "qi", "Week is 41, so it stays qi");
  assert.equal(hot.served.color, "qi");
  assert.equal(hot.tokens.color, "station-steamers");
  const weekHot = byId(rods(usage(50, 100)));
  assert.equal(weekHot.week.color, "alarm");
  assert.equal(weekHot["five-hour"].color, "qi");
  assert.equal(byId(rods(usage(95, 41)))["five-hour"].color, "qi", "spec: alarm when value > 95");
  assert.equal(byId(rods(usage(79, 41)))["five-hour"].color, "qi");
});

test("80% mark: on the 5 h and Week rods only, whatever the value", () => {
  for (const v of [0, 79, 96]) {
    const m = byId(rods(usage(v, v)));
    assert.equal(m["five-hour"].mark80, true, `5 h at ${v}`);
    assert.equal(m.week.mark80, true, `Week at ${v}`);
    assert.equal(m.served.mark80, false);
    assert.equal(m.tokens.mark80, false);
    assert.equal(m.spills.mark80, false);
  }
});

test("usage rods are meters: exact percent in the accessible name, valuenow the number; other rods are not meters", () => {
  const m = byId(rods(usage(79, 41)));
  assert.equal(m["five-hour"].ariaLabel, "5-hour window 79%");
  assert.equal(m["five-hour"].valueNow, 79);
  assert.equal(m.week.ariaLabel, "Week 41%");
  assert.equal(m.week.valueNow, 41);
  for (const id of ["served", "tokens", "spills"]) {
    assert.equal(m[id].ariaLabel, null, `${id} is plain text`);
    assert.equal(m[id].valueNow, null);
  }
});

test("the 5 h and Week rods read the same values as the sidebar meter's usage object (fiveHour, weekly)", () => {
  const m = byId(rods({ fiveHour: 63, weekly: 17, sampledAt: new Date(NOW - 60_000).toISOString() }));
  assert.equal(m["five-hour"].valueNow, 63);
  assert.equal(m.week.valueNow, 17);
  assert.equal(m["five-hour"].counted, 6); // 6.3
  assert.equal(m.week.counted, 2); // 1.7
});

test("status text matches the old sidebar meter: Wind down at 80 to 94, At limit at 95 and up, none below", () => {
  const status = (v) => byId(rods(usage(v, 10)))["five-hour"].statusText ?? null;
  assert.equal(status(79), null);
  assert.equal(status(80), "Wind down");
  assert.equal(status(94), "Wind down");
  assert.equal(status(95), "At limit");
  assert.equal(status(100), "At limit");
  assert.equal(byId(rods(usage(10, 85))).week.statusText, "Wind down");
});

test("sample age line: 'Sampled 12 min ago'; null when nothing was sampled", () => {
  assert.equal(rods(usage(79, 41, 12)).sampledText, "Sampled 12 min ago");
  assert.equal(rods(null).sampledText ?? null, null);
});

test("no usage sample: 5 h and Week are empty, 'not sampled', no valuenow, no status, no alarm, no sample line", () => {
  const r = rods(null);
  const m = byId(r);
  for (const [id, label] of [["five-hour", "5-hour window not sampled"], ["week", "Week not sampled"]]) {
    assert.equal(m[id].counted, 0, id);
    assert.equal(m[id].valueText, "not sampled", id);
    assert.equal(m[id].ariaLabel, label, id);
    assert.equal(m[id].valueNow, null, id);
    assert.equal(m[id].statusText ?? null, null, id);
    assert.notEqual(m[id].color, "alarm", id);
  }
  assert.equal(r.sampledText ?? null, null);
  assert.equal(m.served.counted, 6, "metrics rods are unaffected by a missing usage sample");
});

test("a sample with no weekly figure leaves Week unsampled and 5 h intact", () => {
  const m = byId(rods({ fiveHour: 50, sampledAt: new Date(NOW - 60_000).toISOString() }));
  assert.equal(m["five-hour"].valueNow, 50);
  assert.equal(m.week.valueText, "not sampled");
  assert.equal(m.week.ariaLabel, "Week not sampled");
  assert.equal(m.week.counted, 0);
});

test("metrics still loading (no data): Served, Tokens and Spills read 'no data' with no counted beads; usage is unaffected", () => {
  const m = byId(rods(usage(79, 41), null));
  for (const id of ["served", "tokens", "spills"]) {
    assert.equal(m[id].valueText, "no data", id);
    assert.equal(m[id].counted, 0, id);
  }
  assert.equal(m["five-hour"].counted, 8);
});

test("metrics error: Served, Tokens and Spills read 'unavailable' with no counted beads; usage is unaffected", () => {
  const m = byId(rods(usage(79, 41), metrics(), { error: true }));
  for (const id of ["served", "tokens", "spills"]) {
    assert.equal(m[id].valueText, "unavailable", id);
    assert.equal(m[id].counted, 0, id);
  }
  assert.equal(m["five-hour"].valueText, "79%");
  assert.equal(m["five-hour"].counted, 8);
  assert.equal(m.week.counted, 4);
});

test("over scale: beads clamp at 10 and the text keeps the real value", () => {
  const m = byId(rods(usage(105, 41), metrics({
    throughput: { windows: windows(1, 25) },
    tokensByRole: { developer: { perTicket: 500000 } },
    incidentsByTool: { Bash: { perTicket: 2.5 } },
  })));
  assert.equal(m["five-hour"].counted, 10);
  assert.equal(m.served.counted, 10);
  assert.equal(m.served.valueText, "25 tickets");
  assert.equal(m.tokens.counted, 10);
  assert.equal(m.tokens.valueText, "500k / ticket");
  assert.equal(m.spills.counted, 10);
  assert.equal(m.spills.valueText, "2.5 / ticket");
});

test("the caption that states the three non-usage scales is exact", () => {
  assert.equal(
    TALLY_RODS_CAPTION,
    "Tally rods: Served 1 bead = 1 ticket this window; Tokens 1 bead = 20k per ticket; Spills 1 bead = 0.1 per ticket.",
  );
  assert.equal(rods(usage(79)).caption, TALLY_RODS_CAPTION);
});

test("beads slide over 240 ms (dur-base) only when a count changes; never on mount; reduced motion jumps", () => {
  assert.equal(BEAD_SLIDE_MS, 240);
  assert.deepEqual(beadSlide(null, 8, {}), { animate: false, durationMs: 0 }, "mount");
  assert.deepEqual(beadSlide(undefined, 8, {}), { animate: false, durationMs: 0 }, "mount");
  assert.deepEqual(beadSlide(8, 8, {}), { animate: false, durationMs: 0 }, "re-render, same count");
  assert.deepEqual(beadSlide(8, 9, {}), { animate: true, durationMs: 240 });
  assert.deepEqual(beadSlide(8, 3, {}), { animate: true, durationMs: 240 });
  assert.deepEqual(beadSlide(8, 9, { reducedMotion: true }), { animate: false, durationMs: 0 }, "reduced motion");
});

test("layout: five rods spaced evenly top to bottom below the 0.22 heading band, inside the frame", () => {
  const { rodYs } = abacusLayout();
  assert.equal(rodYs.length, 5);
  const innerTop = 1.4 / 2 - 0.08; // 0.62
  const innerBottom = -(1.4 / 2 - 0.08);
  for (let i = 0; i < 4; i++) assert.ok(rodYs[i] > rodYs[i + 1], "top to bottom");
  const gaps = rodYs.slice(1).map((y, i) => rodYs[i] - y);
  for (const g of gaps) assert.ok(Math.abs(g - gaps[0]) < 1e-9, `even spacing ${gaps}`);
  assert.ok(rodYs[0] < innerTop - 0.22, `top rod ${rodYs[0]} clears the heading band`);
  assert.ok(rodYs[4] > innerBottom, "bottom rod inside the frame");
});

test("layout: ten beads per rod, counted packed right and uncounted packed left, all in the bead span right of the 0.28 label column", () => {
  const L = abacusLayout();
  const innerLeft = -(1.1 / 2 - 0.08); // -0.47
  const innerRight = 1.1 / 2 - 0.08; // 0.47
  assert.ok(Math.abs(L.labelColumnRight - (innerLeft + 0.28)) < 1e-9, `label column right edge ${L.labelColumnRight}`);
  assert.ok(L.beadSpan.min >= L.labelColumnRight - 1e-9 && L.beadSpan.max <= innerRight + 1e-9, JSON.stringify(L.beadSpan));
  for (const counted of [0, 3, 8, 10]) {
    const xs = L.beadX(counted);
    assert.equal(xs.length, 10, `ten beads at ${counted}`);
    for (let i = 0; i < 9; i++) assert.ok(xs[i] < xs[i + 1], `beads keep their order at ${counted}`);
    for (const x of xs) assert.ok(x >= L.beadSpan.min - 1e-9 && x <= L.beadSpan.max + 1e-9, `bead x ${x} inside span at ${counted}`);
  }
  // Counted beads slide right: more counted never moves a bead left.
  const a = L.beadX(3);
  const b = L.beadX(8);
  for (let i = 0; i < 10; i++) assert.ok(b[i] >= a[i] - 1e-9, `bead ${i} moves right (or stays) when the count rises`);
  assert.ok(L.beadX(10)[0] > L.beadX(0)[0], "a full rod sits right of an empty one");
});

test("layout: the 80% mark has 8 beads to its right and 2 to its left when 8 are counted", () => {
  const L = abacusLayout();
  const xs = L.beadX(8);
  assert.equal(xs.filter((x) => x > L.mark80X).length, 8);
  assert.equal(xs.filter((x) => x < L.mark80X).length, 2);
  assert.ok(L.mark80X > L.beadSpan.min && L.mark80X < L.beadSpan.max);
});
