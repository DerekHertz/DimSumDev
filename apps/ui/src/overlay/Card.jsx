// The collapsible card of the right-hand column (den-scene-v1/07), shared by Needs you, Teams & queue and Library.
function Chevron() {
  return (
    <svg className="card-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** A card: a header button (aria-expanded) that opens and closes a body. The body stays in the DOM, hidden, so aria-controls resolves. */
export function Card({ id, overlay, label, edge, open, onToggle, title, aside, busy, children }) {
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
