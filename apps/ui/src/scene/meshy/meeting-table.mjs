// den-mvp/64: a meeting at Bao's table. Which meeting the table shows, where its seats are, what each seat says,
// and the glide route a panda takes to its seat. Pure: the actors and the label layer read it; the snapshot decides.
import {RESIDENTS} from '../../shell/resident-inventory.mjs';
export const TABLE = Object.freeze({ x: 0, z: -4 }); // approved central meeting plaza
export const seatName=role=>RESIDENTS.find(r=>r.role===role&&r.runtime==='claude')?.name??role.replaceAll('-',' ');
export const PLAZA_RING = 8; // the stone ring around the plaza; far teams join it before turning in
export const FAREWELL_MS = 6000; // how long Bao says what you chose before the table clears
export const CLAIM_MAX = 80;
export const GLIDE_SPEED = 1.5; // world units a second, about 8–10 s from the farthest team

const SEATED = new Set(["running", "paused", "briefed"]);
const ENDED = new Set(["decided", "closed"]);
const deg = Math.PI / 180;
// Seat angles around the table, 0 = front (the camera side), -90 = left. Order is the meeting's role order.
const LAYOUTS = [[], [2], [1,4], [1,2,4], [0,1,4,5], [0,1,2,4,5], [0,1,2,3,4,5]];
const ANGLES=[-900/7,-540/7,-180/7,180/7,540/7,900/7];
export const CHAIR_SPOT=Object.freeze({x:0,z:TABLE.z-5.6,yaw:0});
const RX = 5.6, RZ = 5.6;

export const seated = (m) => !!m && SEATED.has(m.state) && !m.retired;

export function tableMeeting(meetings, now = Date.now()) {
  const list = Array.isArray(meetings) ? meetings : [];
  const newest = (rows) => rows.reduce((best, m) => (!best || Date.parse(m.startedAt) > Date.parse(best.startedAt) ? m : best), null);
  const live = newest(list.filter(seated));
  if (live) return live;
  return newest(list.filter((m) => ENDED.has(m.state) && !m.retired && now - Date.parse(m.updatedAt) <= FAREWELL_MS));
}

export function seatSpots(n) {
  const angles = LAYOUTS[Math.max(0, Math.min(n, LAYOUTS.length - 1))];
  return angles.map((index) => {
    const a=ANGLES[index];
    const dx = RX * Math.sin(a * deg), dz = RZ * Math.cos(a * deg);
    return { x: TABLE.x + dx, z: TABLE.z + dz, yaw: Math.atan2(-dx, -dz) };
  });
}

const SEAT_LABELS = {
  waiting: { text: "Waiting to speak", kind: "waiting" },
  taken: { text: "Said its piece", kind: "done" },
  declined: { text: "Passed", kind: "declined" },
  failed: { text: "Couldn't finish", kind: "failed" },
};
export function seatLabel(seat, m) {
  if (m?.live?.role === seat.role) return { text: "Thinking", kind: "thinking" }; // its take, or a follow-up asking it again
  return SEAT_LABELS[seat.status] ?? { text: "In the meeting", kind: "waiting" };
}

export function baoLabel(m) {
  if (m.state === "briefed") return { text: "Brief ready · your choice", kind: "brief" };
  if (m.state === "paused") return { text: "Waiting on you", kind: "brief" };
  if (ENDED.has(m.state)) {
    const last = m.decisions?.at(-1);
    return { text: last ? `You chose ${last.option}` : "Closed", kind: "done" };
  }
  if (m.live?.role === "orchestrator") return { text: "Drafting the brief", kind: "thinking" };
  return { text: "Listening", kind: "waiting" };
}

// Out along the plaza ring when the panda starts beyond it, so it walks in on the stone paths, then to the spot.
export function routeTo(from, to) {
  const end = { x: to.x, z: to.z };
  const r = Math.hypot(from.x, from.z);
  if (r <= PLAZA_RING + 0.5) return [end];
  return [{ x: (from.x / r) * PLAZA_RING, z: (from.z / r) * PLAZA_RING }, end];
}

export function claimOf(text) {
  if (typeof text !== "string") return null;
  const m = /^\s*(?:\*\*)?Claim:(?:\*\*)?\s*(.+)$/m.exec(text);
  if (!m) return null;
  const claim = m[1].trim();
  return claim.length > CLAIM_MAX ? `${claim.slice(0, CLAIM_MAX - 1).trimEnd()}…` : claim;
}
