// dimsumden-ui-v0/11: dashboard chart view-model. Designer spec 07 section 5, ADR 0011 decision 4.
// Interface pinned (apps/ui/src/panel/dashboard-model.mjs):
//   dashboardModel(metrics | null | undefined, { error?: boolean } = {}) ->
//   {
//     status: "ok" | "error",
//     errorText: "Metrics unavailable" | null,   // set only when status is "error"
//     retryLabel: "Retry" | null,                // set only when status is "error"
//     charts: [ throughput, tokens, incidents ],  // exactly these three, in this order (no usage tile)
//   }
//   chart = {
//     id: "throughput" | "tokens" | "incidents",
//     title: string,
//     orientation: "vertical" | "horizontal",
//     empty: boolean, emptyText: "No data yet" | null,
//     bars: [{ label, value, valueText, fraction }],  // fraction = value / max value, in 0..1; [] when empty
//     desc: string,   // svg <desc>: names every bar label and valueText
//   }
// The visually hidden <table> renders `bars` (label, valueText), so it needs no separate field.
// Window labels are UTC ("Sep 29 05:00"). The .jsx draws this output; the usage tile lives in 09 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardModel } from "./dashboard-model.mjs";

const fixture = () => ({
  schema: 1,
  throughput: {
    windowHours: 5,
    windows: [
      { start: "2026-09-28T19:00:00.000Z", resolved: 4 },
      { start: "2026-09-29T00:00:00.000Z", resolved: 0 },
      { start: "2026-09-29T05:00:00.000Z", resolved: 2 },
    ],
  },
  tokensByRole: {
    qa: { tickets: 5, tokens: 400100, perTicket: 80020 },
    developer: { tickets: 5, tokens: 812345, perTicket: 162469 },
    scout: { tickets: 2, tokens: 1900, perTicket: 950 },
  },
  resolvedTickets: 16,
  incidentsByTool: {
    git: { incidents: 2, perTicket: 0.13 },
    "board-claim": { incidents: 3, perTicket: 0.19 },
  },
  usage: { fiveHour: 74, weekly: 72, sampledAt: "2026-09-29T04:36:50.650Z" },
});

const chart = (m, id) => m.charts.find((c) => c.id === id);

test("renders exactly three charts and no usage tile", () => {
  const m = dashboardModel(fixture());
  assert.equal(m.status, "ok");
  assert.deepEqual(m.charts.map((c) => c.id), ["throughput", "tokens", "incidents"]);
});

test("throughput: one vertical bar per window with UTC start labels and resolved counts", () => {
  const c = chart(dashboardModel(fixture()), "throughput");
  assert.equal(c.orientation, "vertical");
  assert.equal(c.empty, false);
  assert.deepEqual(c.bars.map((b) => [b.label, b.value, b.valueText]), [
    ["Sep 28 19:00", 4, "4"],
    ["Sep 29 00:00", 0, "0"],
    ["Sep 29 05:00", 2, "2"],
  ]);
  assert.deepEqual(c.bars.map((b) => b.fraction), [1, 0, 0.5]);
});

test("throughput keeps only the newest 12 windows", () => {
  const m = fixture();
  m.throughput.windows = Array.from({ length: 20 }, (_, i) => ({
    start: new Date(Date.UTC(2026, 8, 1) + i * 5 * 3600_000).toISOString(),
    resolved: i,
  }));
  const c = chart(dashboardModel(m), "throughput");
  assert.equal(c.bars.length, 12);
  assert.deepEqual(c.bars.map((b) => b.value), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
});

test("tokens per ticket: horizontal, sorted descending, abbreviated with k", () => {
  const c = chart(dashboardModel(fixture()), "tokens");
  assert.equal(c.orientation, "horizontal");
  assert.deepEqual(c.bars.map((b) => [b.label, b.value, b.valueText]), [
    ["developer", 162469, "162k"],
    ["qa", 80020, "80k"],
    ["scout", 950, "950"],
  ]);
  assert.equal(c.bars[0].fraction, 1);
  assert.ok(Math.abs(c.bars[1].fraction - 80020 / 162469) < 1e-9);
});

test("incidents per ticket by tool: horizontal, sorted descending, two-decimal values", () => {
  const c = chart(dashboardModel(fixture()), "incidents");
  assert.equal(c.orientation, "horizontal");
  assert.deepEqual(c.bars.map((b) => [b.label, b.value, b.valueText]), [
    ["board-claim", 0.19, "0.19"],
    ["git", 0.13, "0.13"],
  ]);
  assert.equal(c.bars[0].fraction, 1);
});

test("desc names every label and value so the svg is readable without sight", () => {
  const m = dashboardModel(fixture());
  const d = chart(m, "tokens").desc;
  for (const s of ["developer", "162k", "qa", "80k", "scout", "950"]) assert.ok(d.includes(s), `desc missing ${s}`);
  const t = chart(m, "throughput").desc;
  for (const s of ["Sep 28 19:00", "Sep 29 05:00"]) assert.ok(t.includes(s), `desc missing ${s}`);
  for (const c of m.charts) assert.ok(c.title && c.title.length > 0);
});

test("empty metrics (ADR empty shapes) give an empty state per chart, no bars, no error", () => {
  const empty = {
    schema: 1,
    throughput: { windowHours: 5, windows: [] },
    tokensByRole: {},
    resolvedTickets: 0,
    incidentsByTool: {},
    usage: null,
  };
  const m = dashboardModel(empty);
  assert.equal(m.status, "ok");
  assert.equal(m.errorText, null);
  assert.equal(m.charts.length, 3);
  for (const c of m.charts) {
    assert.equal(c.empty, true, c.id);
    assert.equal(c.emptyText, "No data yet");
    assert.deepEqual(c.bars, [], `${c.id} must not draw a zero bar`);
  }
});

test("missing or partial metrics do not throw and read as empty", () => {
  for (const input of [null, undefined, {}, { schema: 1 }]) {
    const m = dashboardModel(input);
    assert.equal(m.status, "ok");
    assert.equal(m.charts.length, 3);
    assert.ok(m.charts.every((c) => c.empty && c.emptyText === "No data yet" && c.bars.length === 0));
  }
});

test("a fetch error shows Metrics unavailable with a Retry action", () => {
  const m = dashboardModel(null, { error: true });
  assert.equal(m.status, "error");
  assert.equal(m.errorText, "Metrics unavailable");
  assert.equal(m.retryLabel, "Retry");
});

test("an ok model carries no error text or retry label", () => {
  const m = dashboardModel(fixture());
  assert.equal(m.errorText, null);
  assert.equal(m.retryLabel, null);
});
