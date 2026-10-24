// den-mvp/64: the labels of a meeting at Bao's table. Each seated panda and Bao get one label from the snapshot; a take
// that lands shows its claim for CLAIM_SHOW_MS. A pill at the top of the scene names the meeting and opens it. World
// anchors (stage.meetingAnchors, written by the scene each frame) are projected to the screen like ChipLayer's chips.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { baoLabel, seatLabel, seated, tableMeeting } from "./meshy/meeting-table.mjs";
import { stackChips } from "./chip-model.mjs";

export const CLAIM_SHOW_MS = 6000;
const GLYPH = { waiting: "…", thinking: "☁", done: "✓", declined: "–", failed: "!", brief: "◆" };
const ticketNumber = (m) => /\/(\d+)-/.exec(m.ref)?.[1] ?? m.title;

export function pillText(m) {
  const n = ticketNumber(m);
  if (m.state === "briefed" || m.state === "paused") return `Meeting on ${n} · waiting on you`;
  if (!seated(m)) return `Meeting on ${n} · ${baoLabel(m).text}`;
  if (m.live?.role === "orchestrator") return `Meeting on ${n} · Bao is drafting the brief`;
  const spoken = m.seats.filter((s) => s.status !== "waiting").length;
  return `Meeting on ${n} · ${spoken} of ${m.seats.length} have spoken`;
}

export function MeetingLayer({ snapshot, stage, claims = {}, onOpen, selectedMeetingId = null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const m = tableMeeting(snapshot?.meetings, now, selectedMeetingId);
  const nodes = useRef(new Map());
  const landed = useRef(new Map()); // role -> when its claim was first shown, for the claim bubble
  const said = useRef(new Map()); // role -> label text last announced
  const [announce, setAnnounce] = useState("");

  const labels = [];
  if (m && seated(m)) for (const s of m.seats) labels.push({ key: s.role, role: s.role, ...seatLabel(s, m) });
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
        const pts = [];
        for (const [key, el] of nodes.current) {
          const a = stage.meetingAnchors?.get(key);
          const v = a ? a.clone().project(camera) : null;
          if (!v || v.z < -1 || v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) { el.style.visibility = "hidden"; continue; }
          pts.push({ ref: key, x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height });
        }
        for (const [key, p] of stackChips(pts, { width: 150, height: 24, gap: 3 })) {
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

  if (!m) return <p className="visually-hidden" role="status" aria-live="polite">{announce}</p>;
  return (
    <div className="meeting-layer">
      <button type="button" className="meeting-pill" data-meeting-pill={m.state} onClick={() => onOpen?.(m.id, null)}>
        <span aria-hidden="true">{GLYPH[m.state === "briefed" || m.state === "paused" ? "brief" : "thinking"]}</span> {pillText(m)}
      </button>
      {labels.map((l) => {
        const at = l.role ? landed.current.get(l.role) : null;
        const claim = l.role && at && Date.now() - at < CLAIM_SHOW_MS ? claims[l.role] : null;
        return (
          <button key={l.key} type="button" ref={(el) => (el ? nodes.current.set(l.key, el) : nodes.current.delete(l.key))}
            className={`meeting-label meeting-${l.kind}`} data-seat={l.key} style={{ visibility: "hidden" }}
            aria-label={`${l.name ?? l.role}: ${l.text}${claim ? `. ${claim}` : ""}`} onClick={() => onOpen?.(m.id, l.role)}>
            {claim ? <span className="meeting-claim">{claim}</span> : null}
            <span className="meeting-tag"><span aria-hidden="true">{GLYPH[l.kind]}</span> {l.name ? `${l.name} · ` : ""}{l.text}</span>
          </button>
        );
      })}
      <p className="visually-hidden" role="status" aria-live="polite">{announce}</p>
    </div>
  );
}
