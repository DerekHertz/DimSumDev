// Status chip copy and tone per pose (designer spec section 2). Pure.
import { compareRefs } from "../../../../packages/board-refs/src/compare-refs.mjs";
const CHIPS = {
  working: { label: "Working", tone: "working" },
  waiting_on_user: { label: "Needs you", tone: "lantern" },
  blocked: { label: "Blocked", tone: "blocked" },
  failed: { label: "Failed", tone: "failed" },
  done: { label: "Done", tone: "done" },
  idle: { label: "Queued", tone: "idle" },
};

// Screen-space de-overlap: chips whose boxes would collide (plushes stacked on Bao's head) are lifted
// upward one chip-height at a time. Order is by ref so the result never depends on input order.
export function stackChips(items, { width = 96, height = 22, gap = 2 } = {}) {
  const out = new Map();
  const placed = [];
  for (const it of [...items].sort((a, b) => compareRefs(a.ref, b.ref))) {
    let y = it.y;
    for (let moved = true; moved; ) {
      moved = false;
      for (const p of placed) {
        if (Math.abs(p.x - it.x) < width && Math.abs(p.y - y) < height + gap) {
          y = p.y - (height + gap);
          moved = true;
        }
      }
    }
    placed.push({ x: it.x, y });
    out.set(it.ref, { x: it.x, y });
  }
  return out;
}

export function chipModel(placement, title) {
  const chip = CHIPS[placement.pose] ?? CHIPS.idle;
  return { ...chip, ariaLabel: `${title ?? placement.ref}, ${chip.label}` };
}

export function sceneActivityModel(placements, selected) {
  const counts = {};
  const rows = placements.map(p => ({ ...p, ...chipModel(p) }));
  for (const row of rows) counts[row.label] = (counts[row.label] ?? 0) + 1;
  const markers = placements.filter(p => p.ref === selected || ['waiting_on_user', 'blocked', 'failed'].includes(p.pose));
  return { counts, rows, markers };
}
