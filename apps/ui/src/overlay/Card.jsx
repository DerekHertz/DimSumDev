import { createContext, useContext } from "react";

// The collapsible card of the right-hand column (den-scene-v1/07), shared by Needs you, Teams & queue and Library.
function Chevron() {
  return (
    <svg className="card-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

// team-and-den-ux/04: inside a rail sheet a card is the sheet's body. The sheet has the title and the close button, so the
// card shows its body open, with its summary line, and no toggle of its own.
export const InSheet = createContext(false);

/** A card: a header button (aria-expanded) that opens and closes a body. The body stays in the DOM, hidden, so aria-controls resolves. */
export function Card({ id, overlay, label, edge, open, onToggle, title, aside, busy, children }) {
  if (useContext(InSheet)) {
    return (
      <section className="card card-in-sheet" data-overlay={overlay} aria-label={label} aria-busy={busy || undefined}>
        {aside ? <p className="card-sheet-summary">{aside}</p> : null}
        <div id={`${id}-body`} className="card-body">{children}</div>
      </section>
    );
  }
  return (
    <section className={`card card-${edge}${open ? "" : " card-closed"}`} data-overlay={overlay} aria-label={label} aria-busy={busy || undefined}>
      <h2 className="card-head">
        <button type="button" className="card-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle}>
          <span className="card-title">{title}</span>{" "}
          {aside}
          <Chevron />
        </button>
      </h2>
      <div id={`${id}-body`} className="card-body" hidden={!open}>{children}</div>
    </section>
  );
}
