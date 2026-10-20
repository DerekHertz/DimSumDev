// team-and-den-ux/04 (design/04-spec.md section 4): a docked sheet over the live scene. Non-modal (the scene beside it
// stays usable, and Tab can leave it), so it is no focus trap. Opening moves focus to its title; the shell's Escape and
// the × close it, and the shell returns focus to what opened it.
import { useEffect, useRef } from "react";
import { InSheet } from "../overlay/Card.jsx";

export function Sheet({ id, slot, eyebrow, title, closeLabel, onClose, wide = false, focusKey, children }) {
  const heading = useRef(null);
  // A new topic swaps the content in place: focus moves to the new title (spec section 4).
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [focusKey]);
  return (
    <section id={id} className={`den-sheet den-sheet-${slot}${wide ? " den-sheet-wide" : ""}`} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} data-sheet={slot}>
      <header className="den-sheet-head">
        <div>
          <p className="den-sheet-eyebrow">{eyebrow}</p>
          <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{title}</h2>
        </div>
        <button type="button" className="den-sheet-close" aria-label={closeLabel} onClick={onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" /></svg>
        </button>
      </header>
      <div className="den-sheet-body"><InSheet.Provider value={true}>{children}</InSheet.Provider></div>
    </section>
  );
}
