// team-and-den-ux/04 (design/04-spec.md section 3): the left icon rail. Eight entries, then the build, the demo, Reset view
// and the expand control. Topic entries open the topic sheet (aria-expanded); Talk to Bao opens the side sheet (aria-pressed).
// Collapsed it shows icons with a tooltip on hover and keyboard focus; expanded (remembered per browser) it shows labels.
import { useState } from "react";
import { createPortal } from 'react-dom';
import { RAIL_ENTRIES, RAIL_FOOTER, entryName } from "./rail-model.mjs";

const RAIL_KEY = "den.rail-open";
const readOpen = () => { try { return localStorage.getItem(RAIL_KEY) === "1"; } catch { return false; } };
const saveOpen = (on) => { try { localStorage.setItem(RAIL_KEY, on ? "1" : "0"); } catch { /* a private window: not remembered */ } };

// One stroke path per icon, drawn at 20px in currentColor.
const ICONS = {
  speech: "M4 5h12v8H9l-4 3v-3H4z",
  bell: "M10 3a4 4 0 0 1 4 4v3l1.5 3h-11L6 10V7a4 4 0 0 1 4-4zM8.5 15.5a1.5 1.5 0 0 0 3 0",
  list: "M7 6h9M7 10h9M7 14h9M4 6h.01M4 10h.01M4 14h.01",
  steamer: "M3 9h14v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM3 9l1-3h12l1 3M8 3c0 1 1 1 1 2M12 3c0 1 1 1 1 2",
  people: "M7 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2.5 16a4.5 4.5 0 0 1 9 0M13.5 9a2 2 0 1 0 0-4M13 12a4 4 0 0 1 4.5 4",
  panda: "M10 16a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM5 5a2 2 0 1 1 2.6-1.4M15 5a2 2 0 1 0-2.6-1.4M8 9.5h.01M12 9.5h.01M9 12.5h2",
  book: "M4 4h5a2 2 0 0 1 2 2v10a2 2 0 0 0-2-2H4zM16 4h-5a2 2 0 0 0-2 2v10a2 2 0 0 1 2-2h5z",
  bars: "M4 16V9M8 16V5M12 16v-6M16 16V7",
  tag: "M3 10V4h6l8 8-6 6zM6.5 7.5h.01",
  play: "M6 4l10 6-10 6z",
  target: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10 10h.01",
};
const Icon = ({ name }) => (
  <svg className="den-rail-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Badge({ badge }) {
  if (badge?.count > 0) return <span className="den-rail-badge" aria-hidden="true">{badge.count > 99 ? '99+' : badge.count}</span>;
  if (badge?.dot) return <span className="den-rail-dot" aria-hidden="true" />;
  return null;
}

/**
 * topic: the open topic id or null; side: true when Bao's conversation is the side sheet; badges: railBadges();
 * onEntry(id, opener) for every entry; buildLabel: "Den v0.1.3"; offline: the bridge is unreachable (entries still open).
 */
export function Rail({ topic, baoOpen, badges, onEntry, buildLabel, demoActive = false, offline = false }) {
  const [open, setOpen] = useState(readOpen);
  const [tip, setTip] = useState(null);
  const showTip = (event, text) => {
    if (open && window.innerWidth > 640) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setTip({ text, left: bounds.right + 8, top: Math.min(bounds.top, window.innerHeight - 48) });
  };
  const toggle = () => setOpen((on) => { saveOpen(!on); return !on; });
  const item = (entry) => {
    const badge = badges?.[entry.id];
    const name = entry.id === "build" ? (buildLabel || entry.label) : entry.id === "demo" && demoActive ? "Stop the demo" : entry.label;
    const label = entryName({ ...entry, label: name }, badge);
    const state = entry.slot === "topic" ? { "aria-expanded": topic === entry.id, "aria-controls": "sheet-topic" } : entry.slot === "side" ? { "aria-pressed": !!baoOpen } : entry.id === "demo" ? { "aria-pressed": demoActive } : {};
    const isOpen = entry.slot === "topic" ? topic === entry.id : entry.slot === "side" ? !!baoOpen : false;
    return (
      <li key={entry.id}>
        <button type="button" className={`den-rail-entry${isOpen ? " is-open" : ""}`} data-rail={entry.id} aria-label={label} data-tip={name} {...state}
          onFocus={e => showTip(e, name)} onBlur={() => setTip(null)} onMouseEnter={e => showTip(e, name)} onMouseLeave={() => setTip(null)}
          onClick={(e) => { setTip(null); onEntry(entry.id, e.currentTarget); }}>
          <Icon name={entry.icon} />
          <span className="den-rail-label">{name}</span>
          <Badge badge={badge} />
        </button>
      </li>
    );
  };
  return (
    <nav className={`den-rail${open ? " is-expanded" : ""}`} aria-label="Den" data-offline={offline || undefined} onScroll={() => setTip(null)}>
      <ul className="den-rail-list">{RAIL_ENTRIES.map(item)}</ul>
      <ul className="den-rail-list den-rail-footer">
        {RAIL_FOOTER.map(item)}
        <li>
          <button type="button" className="den-rail-entry den-rail-expand" aria-expanded={open} aria-label={open ? "Hide labels" : "Show labels"} data-tip={open ? "Hide labels" : "Show labels"} onFocus={e => showTip(e, open ? 'Hide labels' : 'Show labels')} onBlur={() => setTip(null)} onMouseEnter={e => showTip(e, open ? 'Hide labels' : 'Show labels')} onMouseLeave={() => setTip(null)} onClick={() => { setTip(null); toggle(); }}>
            <svg className="den-rail-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d={open ? "M12 5l-5 5 5 5" : "M8 5l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="den-rail-label">{open ? "Hide labels" : "Show labels"}</span>
          </button>
        </li>
      </ul>
      {tip ? createPortal(<span className="den-rail-tooltip" aria-hidden="true" style={{left:tip.left, top:tip.top}}>{tip.text}</span>, document.body) : null}
    </nav>
  );
}
