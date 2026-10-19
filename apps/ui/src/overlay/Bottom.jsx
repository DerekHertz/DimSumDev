// The three overlays along the bottom of the scene (den-scene-v1/07): zoom switcher bottom-left, intent bar
// bottom-centre, timeline bottom-right. Numbers and copy: docs/design/2026-10-01-iso-den.md section 4.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { LEVEL_ZOOM, levelOfZoom } from "../scene/camera-store.mjs";
import { TEAM_HUE, clockText, timelineMarkers } from "./overlay-model.mjs";

const LEVELS = [
  { level: 1, label: "1 · Den" },
  { level: 2, label: "2 · Team" },
  { level: 3, label: "3 · Panda" },
  { level: 4, label: "4 · Workspace" },
];

function Glyph({ d }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Levels dolly the camera; + and - step the same zoom the wheel, pinch and keys move. `data-zoom` is that live value. */
export function ZoomSwitcher({ camera }) {
  const zoom = useSyncExternalStore(camera.subscribe, camera.getZoom);
  const current = levelOfZoom(zoom,camera.levels);
  return (
    <nav className="zoom-switcher" data-overlay="zoom" data-zoom={zoom} aria-label="Zoom level">
      <div className="zoom-levels">
        {LEVELS.map(({ level, label }) => {
          const ready = level in LEVEL_ZOOM;
          return (
            <button
              key={level}
              type="button"
              className="zoom-level"
              aria-current={level === current ? "true" : undefined}
              aria-disabled={ready ? undefined : "true"}
              title={ready ? undefined : "Workspace is coming online"}
              onClick={() => { if (ready) camera.goToLevel(level); }}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="zoom-steps">
        <button type="button" className="zoom-step" aria-label="Zoom in" onClick={() => camera.stepZoom("+")}><Glyph d="M8 3v10M3 8h10" /></button>
        <button type="button" className="zoom-step" aria-label="Zoom out" onClick={() => camera.stepZoom("-")}><Glyph d="M3 8h10" /></button>
      </div>
    </nav>
  );
}

/**
 * The intent bar. The bridge has no intent endpoint yet (ADR 0016 slices cover dispatch, approve, message, kill), so
 * Send is marked aria-disabled. The autonomy chip shows the mode but is disabled until den-scene-v1/13 builds the real
 * control; it stays a focusable button (aria-disabled, not the disabled attribute) so a keyboard user reaches the reason.
 */
export function IntentBar() {
  const input = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <section className="intent" data-overlay="intent" aria-label="Intent">
      <p className="intent-current"><span className="intent-current-label">Current intent</span><span className="intent-current-value">none set</span></p>
      <form className="intent-bar" onSubmit={(e) => e.preventDefault()}>
        <button type="button" className="autonomy-chip" aria-label="Autonomy: gated" aria-disabled="true" aria-describedby="autonomy-reason" title="Autonomy controls are coming soon">
          <span className="autonomy-dot" aria-hidden="true" />
          <span className="autonomy-text">gated</span>
        </button>
        <span id="autonomy-reason" className="visually-hidden">Autonomy controls are coming soon.</span>
        <input ref={input} className="intent-input" type="text" aria-label="Give the den an intent" placeholder="Give the den an intent…" autoComplete="off" />
        <kbd className="intent-hint">Ctrl K</kbd>
        <button type="submit" className="intent-send" aria-disabled="true" title="Intents are not connected to the den yet">Send</button>
      </form>
    </section>
  );
}

const MARKER_COLOUR = { pass: `var(${TEAM_HUE.pass})`, lantern: "var(--lantern-fill)", alarm: "var(--alarm)" };

export function Timeline({ snapshot, now }) {
  const markers = timelineMarkers(snapshot, now);
  return (
    <section className="timeline" data-overlay="timeline" aria-label="Timeline">
      <div className="timeline-head">
        <span className="timeline-live">Live</span>
        <span className="timeline-time">{clockText(now)}</span>
      </div>
      <div className="timeline-track" aria-hidden="true">
        {markers.map((m) => (
          <span key={m.ref} className={`timeline-dot timeline-dot-${m.tone}`} style={{ left: `${m.at * 100}%`, background: MARKER_COLOUR[m.tone] }} />
        ))}
      </div>
      <p className="timeline-caption">Drag back to replay the den's history</p>
    </section>
  );
}
