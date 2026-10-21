// The replays the den can open by name (?replay=<id>). A recorded run is exported from the board by
// scripts/hierarchy-replay-export.mjs and committed here; the sample is built in code and always labelled as one.
// Serving saved runs from the board itself needs a bridge read route: docs/agents/hierarchy-replay.md, "Gaps".
export const RUNS = Object.freeze([
  { id: "sample", label: "Illustrative sample", illustrative: true, load: async () => (await import("../sample-run.mjs")).SAMPLE_RUN },
  { id: "team-and-den-ux-50", label: "Recorded: team-and-den-ux/50 terrain clearance (PR 384)", illustrative: false, load: async () => (await import("./team-and-den-ux-50.json")).default },
]);
export const runEntry = (id) => RUNS.find((r) => r.id === id) ?? null;
/** The replay named in a location's query (?replay=<id>), or null. */
export function replayParam(search) {
  try { const id = new URLSearchParams(search).get("replay"); return id && /^[a-z0-9-]{1,60}$/.test(id) ? id : null; } catch { return null; }
}
