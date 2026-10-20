// den-scene-v1/05: the Tally abacus view-model. Pure: no three, React or DOM. The renderer
// (TallyFace.jsx) draws the rods and beads; the expanded card (TallyCard.jsx) draws the same rods as rows.
// On the abacus, incidents read as "spills"; the panel keeps its wording. Designer spec: handoffs/05-designer-spec.md.
import { tokenText } from "../panel/dashboard-model.mjs";
import { usageMeterModel } from "../panel/usage-meter-model.mjs";

export const TALLY_LABEL = "Tally";
export const TALLY_ARIA_LABEL = "Tally: open the dashboard";
/** DOM id of the expanded card; the pill's aria-controls points at it. */
export const TALLY_CARD_ID = "tally-card";
export const TALLY_RODS_CAPTION =
  "Tally rods: Served 1 bead = 1 ticket this window; Tokens 1 bead = 20k per ticket; Spills 1 bead = 0.1 per ticket.";

/** dur-base: how long counted beads slide when a count changes. */
export const BEAD_SLIDE_MS = 240;

const BEADS = 10;
// Scales for the rods whose value has no natural 0..100 (the face view-model only had relative bars).
const SERVED_SCALE = 10; // tickets resolved in the latest window
const TOKENS_SCALE = 200_000; // mean tokens per resolved ticket
const SPILLS_SCALE = 1; // summed incidents per ticket

/** Counted beads = round(value / scale x 10), clamped to 0..10. Anything non-finite counts 0. */
export function beadCount(value, scale) {
  const n = Math.round((value / scale) * BEADS);
  return Number.isFinite(n) ? Math.max(0, Math.min(BEADS, n)) : 0;
}

const usageRod = ({ id, label, ariaName, value }) => {
  const sampled = typeof value === "number" && Number.isFinite(value);
  return {
    id,
    label,
    kind: "usage",
    counted: sampled ? beadCount(value, 100) : 0,
    // Designer spec: counted beads turn alarm past 95 (strictly); the status text follows the sidebar meter's >= 95.
    color: sampled && value > 95 ? "alarm" : "qi",
    valueText: sampled ? `${value}%` : "not sampled",
    statusText: !sampled ? null : value >= 95 ? "At limit" : value >= 80 ? "Wind down" : null,
    mark80: true,
    ariaLabel: `${ariaName} ${sampled ? `${value}%` : "not sampled"}`,
    valueNow: sampled ? value : null,
  };
};

const metricRod = ({ id, label, color, state, value, scale, text }) => ({
  id,
  label,
  kind: "metric",
  counted: state === "ok" ? beadCount(value, scale) : 0,
  color,
  valueText: state === "ok" ? text(value) : state === "error" ? "unavailable" : "no data",
  statusText: null,
  mark80: false,
  ariaLabel: null,
  valueNow: null,
});

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * The five rods, top to bottom, for both the 3D abacus and the card rows.
 * @param usage the snapshot's usage object (fiveHour, weekly, sampledAt) or null
 * @param model dashboardModel(...) output (status plus the three charts)
 */
export function tallyRods(usage, model, nowMs) {
  const chart = (id) => model.charts.find((c) => c.id === id);
  const stateOf = (c) => (model.status === "error" ? "error" : !c || c.empty ? "empty" : "ok");
  const served = chart("throughput");
  const tokens = chart("tokens");
  const spills = chart("incidents");
  const mean = (c) => c.bars.reduce((s, b) => s + b.value, 0) / c.bars.length;
  const sum = (c) => round3(c.bars.reduce((s, b) => s + b.value, 0));
  return {
    rods: [
      usageRod({ id: "five-hour", label: "5 h", ariaName: "5-hour window", value: usage?.fiveHour }),
      usageRod({ id: "week", label: "Week", ariaName: "Week", value: usage?.weekly }),
      metricRod({
        id: "served", label: "Served", color: "qi", state: stateOf(served), scale: SERVED_SCALE,
        value: served?.bars.at(-1)?.value,
        text: (v) => `${v} ${v === 1 ? "ticket" : "tickets"}`,
      }),
      metricRod({
        id: "tokens", label: "Tokens", color: "team-steamers", state: stateOf(tokens), scale: TOKENS_SCALE,
        value: tokens && !tokens.empty ? mean(tokens) : undefined,
        text: (v) => `${tokenText(v)} / ticket`,
      }),
      metricRod({
        id: "spills", label: "Spills", color: "alarm", state: stateOf(spills), scale: SPILLS_SCALE,
        value: spills && !spills.empty ? sum(spills) : undefined,
        text: (v) => `${v} / ticket`,
      }),
    ],
    caption: TALLY_RODS_CAPTION,
    sampledText: usageMeterModel(usage, nowMs).sampledText,
  };
}

/** Beads slide only when a count changes (never on mount), and jump under reduced motion. */
export function beadSlide(prevCounted, nextCounted, { reducedMotion = false } = {}) {
  const changed = typeof prevCounted === "number" && prevCounted !== nextCounted;
  return changed && !reducedMotion ? { animate: true, durationMs: BEAD_SLIDE_MS } : { animate: false, durationMs: 0 };
}

// Frame-local units, origin at the frame centre, +x right, +y up. Frame 1.1 x 1.4 with 0.08 bars.
const INNER = { left: -0.47, right: 0.47, top: 0.62, bottom: -0.62 };
const HEADING = 0.22;
const LABEL_COLUMN = 0.28;
const BEAD_PITCH = 0.06; // squashed beads: ten fit the 0.66 span with a 0.06 gap between counted and uncounted
const BEAD_HALF = BEAD_PITCH / 2;

/** Where the rods, labels, beads and the 80% mark sit on the frame. */
export function abacusLayout() {
  const slot = (INNER.top - HEADING - INNER.bottom) / 5;
  const rodYs = Array.from({ length: 5 }, (_, i) => INNER.top - HEADING - slot * (i + 0.5));
  const labelColumnRight = INNER.left + LABEL_COLUMN;
  const beadSpan = { min: labelColumnRight, max: INNER.right };
  // Uncounted beads rest packed left, counted beads packed right; bead 0 is the leftmost.
  const beadX = (counted) =>
    Array.from({ length: BEADS }, (_, i) =>
      i < BEADS - counted
        ? beadSpan.min + BEAD_HALF + i * BEAD_PITCH
        : beadSpan.max - BEAD_HALF - (BEADS - 1 - i) * BEAD_PITCH,
    );
  const eight = beadX(8);
  return { rodYs, labelColumnRight, beadSpan, mark80X: (eight[1] + eight[2]) / 2, beadX, beadHalfWidth: BEAD_HALF, innerLeft: INNER.left, innerRight: INNER.right, headingY: INNER.top - HEADING / 2 };
}
