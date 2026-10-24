// den-mvp/64: the labels of a meeting at Bao's table. Each seated panda and Bao get one label from the snapshot; a take
// that lands shows its claim for CLAIM_SHOW_MS. A pill at the top of the scene names the meeting and opens it. World
// anchors (stage.meetingAnchors, written by the scene each frame) are projected to the screen like ChipLayer's chips.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { baoLabel, seatLabel, seatName, seated, tableMeeting } from "./meshy/meeting-table.mjs";
import { stackChips } from "./chip-model.mjs";
import { meetingPillLabel, recentActivity } from '../overlay/meeting-model.mjs';

export const CLAIM_SHOW_MS = 6000;
const GLYPH = { waiting: "…", thinking: "☁", done: "✓", declined: "–", failed: "!", brief: "◆" };
const ticketNumber = (m) => /\/(\d+)-/.exec(m.ref)?.[1] ?? m.title;

export function pillText(m) {
  if (m.schema === 2) return meetingPillLabel(m);
  const n = ticketNumber(m);
  if (m.state === "briefed" || m.state === "paused") return `Meeting on ${n} · Needs you`;
  if (!seated(m)) return `Meeting on ${n} · ${baoLabel(m).text}`;
  if (m.live?.role === "orchestrator") return `Meeting on ${n} · Bao is drafting the brief`;
  const spoken = m.seats.filter((s) => s.status !== "waiting").length;
  return `Meeting on ${n} · ${spoken} of ${m.seats.length} have spoken`;
}

export function MeetingLayer({ snapshot, stage, claims = {}, onOpen, onOpenAgent, onOpenWork, selectedMeetingId = null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const m = tableMeeting(snapshot?.meetings, now, selectedMeetingId);
  const nodes = useRef(new Map());
  const landed = useRef(new Map()); // role -> when its claim was first shown, for the claim bubble
  const said = useRef(new Map()); // role -> label text last announced
  const [announce, setAnnounce] = useState("");
  const [showActivity, setShowActivity] = useState(false);
  const activity = recentActivity(snapshot);

  const labels = [];
  if (m && seated(m)) for (const s of m.seats) labels.push({ key: s.role, role: s.role, name:seatName(s.role), ...seatLabel(s, m) });
  if (m) labels.push({ key: "orchestrator", role: null, name: m.moderator === 'jiao' ? 'Jiao' : 'Bao', ...baoLabel(m) });

  useEffect(() => {
    if (!m) { landed.current.clear(); said.current.clear(); return; }
    const lines = [];
    for (const l of labels) {
      // The claim's clock starts once the claim has loaded and the seat is in the scene, so a slow load never eats it.
      if (l.kind === "done" && l.role && claims[l.role] && stage.meetingAnchors?.has(l.role) && !landed.current.has(l.role)) landed.current.set(l.role, Date.now());
      if (said.current.get(l.key) !== l.text) {
        if (said.current.has(l.key) || l.kind !== "waiting") lines.push(`${l.name ?? l.role}: ${l.text}`);
        said.current.set(l.key, l.text);
      }
    }
    if (lines.length) setAnnounce(lines.join(". "));
  });

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const { camera } = stage;
      const size = camera?.userData.viewport ?? stage.size;
      if (camera && size) {
        camera.updateMatrixWorld();
        // Seats sit close together, so at the Den zoom their labels stack upward instead of overlapping.
        const pts = [];let labelWidth=0,labelHeight=24;
        for (const [key, el] of nodes.current) {
          const a = stage.meetingAnchors?.get(key);
          const v = a ? a.clone().project(camera) : null;
          if (!v || v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) { el.style.visibility = "hidden"; continue; }
          const bounds=el.getBoundingClientRect();labelWidth=Math.max(labelWidth,bounds.width);labelHeight=Math.max(labelHeight,bounds.height);
          pts.push({ ref: key, x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height });
        }
        for (const [key, p] of stackChips(pts, { width: labelWidth, height: labelHeight, gap: 3 })) {
          const el = nodes.current.get(key);
          el.style.left = `${p.x}px`;
          el.style.top = `${p.y}px`;
          el.style.visibility = "visible";
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [stage]);

  return (
    <div className="meeting-layer">
      {m ? <button type="button" className="meeting-pill" data-meeting-pill={m.state} onClick={() => onOpen?.(m.id, null)}>
        <span aria-hidden="true">{GLYPH[m.state === "briefed" || m.state === "paused" ? "brief" : "thinking"]}</span> {pillText(m)}
      </button> : null}
      <aside className="meeting-feed glass" aria-label="Recent activity">
        <button type="button" aria-expanded={showActivity} onClick={() => setShowActivity(value => !value)}>Recent activity {showActivity ? '−' : '+'}</button>
        {showActivity ? <ul>{activity.map(entry => <li key={entry.key}><button type="button" onClick={() => entry.kind === 'meeting' ? onOpen?.(entry.target, entry.actor) : entry.kind === 'agent' ? onOpenAgent?.(entry.target) : onOpenWork?.(entry.target)}>{entry.text}</button></li>)}{!activity.length ? <li>No recent activity.</li> : null}</ul> : null}
      </aside>
      {labels.map((l) => {
        const at = l.role ? landed.current.get(l.role) : null;
        const claim = l.role && at && Date.now() - at < CLAIM_SHOW_MS ? claims[l.role] : null;
        return (
          <button key={l.key} type="button" ref={(el) => (el ? nodes.current.set(l.key, el) : nodes.current.delete(l.key))}
            className={`meeting-label meeting-${l.kind}`} data-seat={l.key} style={{ visibility: "hidden" }}
            aria-label={`${l.name ?? l.role}: ${l.text}${claim ? `. ${claim}` : ""}`} onClick={() => onOpen?.(m.id, l.role)}>
            {claim ? <span className="meeting-claim">{claim}</span> : null}
            <span className="meeting-tag"><span aria-hidden="true">{GLYPH[l.kind]}</span> {(l.name ?? l.role).replace(/^The /,'')}</span>
          </button>
        );
      })}
      <p className="visually-hidden" role="status" aria-live="polite">{announce}</p>
    </div>
  );
}
