// den-mvp/62 (spec .scratch/den-mvp/handoffs/62-designer-spec.md): the Queue drawer. Needs you, then the goals with their
// tickets in dependency order. A ticket row expands in place to the den's own Run and Deliver controls (passed in as
// `controls`), so acting on a ticket works exactly as it does in Teams & queue.
import { useEffect, useMemo, useRef, useState } from "react";
import { queueDrawerModel } from "./queue-drawer-model.mjs";

const STATE_LABEL = { ready: "ready", review: "in review", you: "needs you", waiting: "waiting" };
const BAR_ORDER = ["review", "ready", "you", "waiting"];

export function QueueButton({ count, open, onToggle, buttonRef }) {
  return (
    <button ref={buttonRef} type="button" className="queue-button" aria-expanded={open} aria-controls="queue-drawer" onClick={onToggle}>
      Queue <span className={`queue-badge${count > 0 ? " queue-badge-on" : ""}`} aria-label={`${count} waiting on you`}>{count}</span>
    </button>
  );
}

export function QueueDrawer({ snapshot, now, open, onClose, onOpenNeeds, onOpenTicket, controls, inSheet = false }) {
  const model = useMemo(() => queueDrawerModel(snapshot, now), [snapshot, now]);
  const [shownGoal, setShownGoal] = useState(undefined); // undefined: follow the model's first goal with a ready ticket
  const [expanded, setExpanded] = useState(null);
  const heading = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || inSheet) return undefined; // team-and-den-ux/04: in a rail sheet, the sheet owns focus and Escape
    heading.current?.focus({ preventScroll: true });
    const keys = (e) => { if (e.key === "Escape") { e.preventDefault(); close.current(); } };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [open, inSheet]);
  const openGoals = new Set(shownGoal === undefined ? [model.openGoal] : shownGoal);
  const toggleGoal = (key) => {
    const next = new Set(openGoals);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setShownGoal([...next]);
  };
  return (
    <section id="queue-drawer" className="queue-drawer" data-open={open} aria-label="Queue" aria-hidden={!open} inert={open ? undefined : ""}>
      {inSheet ? <p className="queue-meta card-sheet-summary">{model.openCount} open</p> : (
        <header className="queue-head">
          <h2 ref={heading} tabIndex={-1}>Queue</h2>
          <span className="queue-meta">{model.openCount} open</span>
          <button type="button" className="btn btn-outline queue-close" onClick={onClose} aria-label="Close the queue">Close</button>
        </header>
      )}
      <div className="queue-body">
        <section aria-label="Needs you">
          <p className="ov">Needs you</p>
          {model.needs.length === 0 ? <p className="muted small">Nothing waits on you.</p> : (
            <ul className="queue-needs">
              {model.needs.map((n) => (
                <li key={n.key}>
                  <button type="button" className="queue-need" onClick={onOpenNeeds}>
                    <span className="queue-need-kind">{n.kind}</span>
                    <span className="queue-need-text">{n.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Goals">
          <p className="ov">Goals</p>
          {model.goalErrors.length ? <p className="queue-alarm small" role="status">goals.md: {model.goalErrors[0]}</p> : null}
          {model.goals.length === 0 ? <p className="muted small">No open tickets.</p> : null}
          <div className="queue-goals">
            {model.goals.map((g) => {
              const isOpen = openGoals.has(g.key);
              return (
                <div key={g.key ?? "none"} className="queue-goal" data-open={isOpen}>
                  <button type="button" className="queue-goal-head" aria-expanded={isOpen} onClick={() => toggleGoal(g.key)}>
                    <span className="queue-goal-name">{g.name}</span>
                    <span className="queue-goal-count">{g.counts.open} · {g.counts.ready} ready · {g.counts.you} you</span>
                    <span className="queue-bar" aria-hidden="true">
                      {BAR_ORDER.filter((k) => g.counts[k]).map((k) => <span key={k} className={`queue-bar-${k}`} style={{ width: `${(100 * g.counts[k]) / g.counts.open}%` }} />)}
                    </span>
                    <span className="queue-goal-why">{g.why}</span>
                  </button>
                  {isOpen ? (
                    <div className="queue-tickets">
                      {g.next.length ? <p className="queue-next small"><b>Next:</b> {g.next.map((ref) => g.tickets.find((t) => t.ref === ref)).map((t) => `${t.short.split("-")[0]} ${t.title.replace(/^\d+:\s*/, "")}`).join("; ")}</p> : null}
                      <ul>
                        {g.tickets.map((t) => (
                          <li key={t.ref} className={`queue-ticket queue-${t.state}`} style={{ "--depth": t.depth }}>
                            <button type="button" className="queue-ticket-row" aria-expanded={expanded === t.ref} onClick={() => setExpanded(expanded === t.ref ? null : t.ref)}>
                              <span className="queue-ticket-ref">{t.short.split("-")[0]}</span>
                              <span className="queue-ticket-title">{t.title.replace(/^\d+:\s*/, "")}</span>
                              <span className="queue-state">{STATE_LABEL[t.state]}</span>
                              {t.waitsOn.length ? <span className="queue-waits">waits on {t.waitsOn.map((s) => s.split("-")[0]).join(", ")}</span> : null}
                            </button>
                            {t.mergeWait ? (
                              <p className="queue-merge-wait small">
                                Waiting on your merge: {t.mergeWait.url ? <a href={t.mergeWait.url} target="_blank" rel="noreferrer noopener">PR #{t.mergeWait.number}</a> : `PR #${t.mergeWait.number}`}
                              </p>
                            ) : null}
                            {expanded === t.ref ? (
                              <div className="queue-ticket-actions">
                                {controls ? controls({ ref: t.ref, type: t.type }) : null}
                                <button type="button" className="btn btn-outline" onClick={() => onOpenTicket?.(t.ref)}>Details</button>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </section>
  );
}
