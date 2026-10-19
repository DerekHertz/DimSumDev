// The expanded Tally (den-scene-v1/05, designer spec-2): a non-modal dialog card floating over the scene
// above the Tally pill. It shows the five rods with exact values and the Dashboard charts. The values come
// from the same tallyRods view-model as the abacus, so card and abacus never disagree.
// Esc, the Close button and the pill close it and return focus to the pill; a pointerdown outside the card
// and the pill closes it without moving focus.
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { Dashboard } from "../panel/Dashboard.jsx";
import { TALLY_CARD_ID } from "./tally-face.mjs";

const HEADING_ID = "tally-card-title";
const GAP = 8; // card bottom to pill top
const MARGIN = 16; // space-4
const FLOOR = 280;

function Strip({ rod }) {
  const beads = Array.from({ length: 10 }, (_, i) => i >= 10 - rod.counted);
  return (
    <span className="tally-strip" aria-hidden="true">
      {beads.map((on, i) => (
        <span key={i} className={on ? `tally-bead tally-bead-on bead-${rod.color}` : "tally-bead"} />
      ))}
      {rod.mark80 ? <span className="tally-mark" data-mark="80" /> : null}
    </span>
  );
}

function RodRow({ rod }) {
  const body = (
    <>
      <span className="tally-rod-label">{rod.label}</span>
      <Strip rod={rod} />
      <span className="tally-rod-value">
        <span className="tally-rod-text">{rod.valueText}</span>
        {rod.statusText ? <span className={`small tally-status ${rod.statusText === "At limit" ? "tally-status-limit" : "tally-status-wind"}`}>{rod.statusText}</span> : null}
      </span>
    </>
  );
  const common = { className: "tally-rod", "data-rod": rod.id, "data-counted": rod.counted };
  return rod.kind === "usage" ? (
    <div
      {...common}
      role="meter"
      aria-label={rod.ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={rod.valueNow ?? undefined}
    >
      {body}
    </div>
  ) : (
    <div {...common}>{body}</div>
  );
}

export function TallyCard({ tally, metrics, failed, onRetry, onClose, stage }) {
  const card = useRef(null);
  const heading = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Place above the pill once on open and again when the scene resizes (never per frame).
  useLayoutEffect(() => {
    const el = card.current;
    const scene = el?.closest("main");
    if (!el || !scene) return undefined;
    const place = () => {
      const s = scene.getBoundingClientRect();
      const pill = scene.querySelector(".chip-tally")?.getBoundingClientRect();
      const width = Math.min(480, s.width - 2 * MARGIN);
      const center = pill ? pill.left + pill.width / 2 - s.left : s.width / 2;
      const left = Math.max(MARGIN, Math.min(center - width / 2, s.width - MARGIN - width));
      const room = pill ? pill.top - s.top - GAP - MARGIN : s.height - 2 * MARGIN;
      el.style.setProperty("--card-left", `${left}px`);
      if (pill && room >= FLOOR) {
        el.removeAttribute("data-pinned");
        el.style.setProperty("--card-bottom", `${s.height - (pill.top - s.top - GAP)}px`);
        el.style.setProperty("--card-max-h", `${room}px`);
      } else {
        el.setAttribute("data-pinned", "");
        el.style.removeProperty("--card-bottom");
        el.style.removeProperty("--card-max-h");
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(scene);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const el = card.current;
    // Esc anywhere while open. Capture, so it still works when focus is on the scene or another control.
    const onEsc = (e) => {
      if (e.key === "Escape") close.current(true);
    };
    // Close on a pointerdown outside the card and the pill. A press on the abacus itself sets stage.tallyHit
    // (the canvas handler runs before this one), so a stray click on the 3D object never closes the card.
    const onOutside = (e) => {
      if (stage?.tallyHit) {
        stage.tallyHit = false;
        return;
      }
      if (e.target instanceof Element && e.target.closest(".tally-card, .chip-tally")) return;
      close.current(false);
    };
    // Arrow keys, + and - belong to the card, not the camera rig listening on <main>. A native listener,
    // because React's synthetic stopPropagation runs at the root, after main's own listener.
    const onKey = (e) => e.stopPropagation();
    const resetHit = () => { if (stage) stage.tallyHit = false; };
    resetHit(); // the press that opened the card may have been on the abacus
    document.addEventListener("pointerdown", resetHit, true);
    document.addEventListener("keydown", onEsc, true);
    document.addEventListener("pointerdown", onOutside);
    el.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", resetHit, true);
      document.removeEventListener("keydown", onEsc, true);
      document.removeEventListener("pointerdown", onOutside);
      el.removeEventListener("keydown", onKey);
    };
  }, [stage]);

  return (
    <div ref={card} id={TALLY_CARD_ID} className="tally-card" role="dialog" aria-modal="false" aria-labelledby={HEADING_ID}>
      <header className="tally-card-head">
        <h2 id={HEADING_ID} ref={heading} tabIndex={-1}>Tally</h2>
        <button type="button" className="tally-close" aria-label="Close Tally" onClick={() => onClose(true)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </header>
      <TallyBody tally={tally} metrics={metrics} failed={failed} onRetry={onRetry} />
    </div>
  );
}

/** The rods and the pipeline charts: the Tally card's body, and the rail's Tally sheet (team-and-den-ux/04). */
export function TallyBody({ tally, metrics, failed, onRetry }) {
  return (
    <div className="tally-card-body" role="region" aria-label="Tally metrics" tabIndex={0}>
      <section className="tally-section">
        <h3 className="tally-h3">The rods</h3>
        <p className="small tally-caption">{tally.caption}</p>
        {tally.rods.map((rod) => (
          <Fragment key={rod.id}>
            <RodRow rod={rod} />
            {rod.id === "week" && tally.sampledText ? <p className="small tally-caption">{tally.sampledText}</p> : null}
          </Fragment>
        ))}
      </section>
      <section className="tally-section">
        <h3 className="tally-h3">Pipeline</h3>
        <Dashboard metrics={metrics} failed={failed} onRetry={onRetry} />
      </section>
    </div>
  );
}
