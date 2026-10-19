// organism-infra/212: the band text for the board's queue. Pure and dependency-free: a mod runs with
// no Node. Input is what scripts/queue.mjs --json returns: { inFlight, ready, waitingOnUser, blocked, proposed }.
//   now: 212 Queue mod (developer) · 213 Next one (qa verify)
//   next: 143 Steering adapter · 210 Agent budget · 211 Token economics
// At most two lines, each at most MAX characters. Anything that is not a queue renders "".
const MAX = 120;
const NEXT = 3;

const num = (ref) => /(?:^|\/)0*(\d+)/.exec(String(ref ?? ""))?.[1] ?? "";
const rows = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === "object" && !Array.isArray(r) && typeof r.ref === "string") : []);

function clip(text) {
  const chars = [...text];
  return chars.length <= MAX ? text : `${chars.slice(0, MAX - 1).join("").trimEnd()}…`;
}

const flight = (r) => {
  const holder = r.role ?? r.cell; // `cell` before ADR 0028
  const who = holder ? ` (${holder}${r.mode ? ` ${r.mode}` : ""})` : "";
  return `${num(r.ref)} ${r.title ?? ""}${who}`.trim();
};

export function renderBand(queue) {
  if (!queue || typeof queue !== "object" || Array.isArray(queue)) return "";
  const inFlight = rows(queue.inFlight);
  const proposed = rows(queue.proposed);
  const next = (proposed.length ? proposed : rows(queue.ready)).slice(0, NEXT);

  const out = [];
  if (inFlight.length) out.push(clip(`now: ${inFlight.map(flight).join(" · ")}`));
  if (next.length) out.push(clip(`next: ${next.map((r) => `${num(r.ref)} ${r.title ?? ""}`.trim()).join(" · ")}`));
  return out.join("\n");
}
