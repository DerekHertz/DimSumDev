import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createApprovalReview, NOTE_MAX } from "./approval-review.mjs";
import { AgentMarkdown } from "./agent-markdown.mjs";
import { QuestionFields } from './QuestionFields.jsx';

// den-v1/06: the permission review. The controller (approval-review.mjs) owns every rule; this file renders its
// state and forwards keys, clicks and each new snapshot. Refusal text is inserted as plain text.
export function useApprovalReview({ client, card, exploring, cursorFree, demo, snapshot, onOpen }) {
  const latest = useRef({});
  latest.current = { card, exploring, cursorFree, demo, onOpen };
  const review = useMemo(() => createApprovalReview({ client, hooks: { onOpen: () => latest.current.onOpen?.() } }), [client]);
  const state = useSyncExternalStore(review.subscribe, review.getState);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const { card: nearby, exploring: walking, cursorFree: free, demo: off } = latest.current;
      const inNote = !!e.target?.closest?.("input,select,textarea,[contenteditable]");
      const mode = walking ? (free ? "free" : "walk") : "diorama";
      const { handled } = review.key({ key: e.key, repeat: e.repeat, inNote }, { card: nearby, mode, demo: off });
      if (!handled) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [review]);

  useEffect(() => { review.sync({ approvals: snapshot?.approvals ?? [], agents: snapshot?.agents ?? [] }); }, [review, snapshot]);
  useEffect(() => {
    if (!state.open) return undefined;
    const timer = setInterval(() => review.tick(), 1000);
    return () => clearInterval(timer);
  }, [review, state.open]);
  useEffect(() => { if (!exploring) review.close(); }, [review, exploring]);

  const openFrom = useCallback((nearby) => {
    const { cursorFree: free, demo: off } = latest.current;
    review.open(nearby, { mode: free ? "free" : "walk", demo: off });
  }, [review]);
  return { review, state, openFrom };
}

export function ApprovalPanel({ review, state }) {
  const refs = { deny: useRef(null), allow: useRef(null), close: useRef(null) };
  useEffect(() => { if (state.open && state.focus) refs[state.focus]?.current?.focus({ preventScroll: true }); }, [state.focusSeq]);
  useEffect(() => {
    if (state.open || !state.focusReturn) return;
    const target = state.focusReturn === "card-button"
      ? document.querySelector(".proximity-card button[data-key=E]:not(:disabled)") ?? document.querySelector(".proximity-card button[data-key=R]:not(:disabled)")
      : null;
    (target ?? document.querySelector('main[aria-label="Den scene"]'))?.focus({ preventScroll: true });
  }, [state.focusSeq, state.open, state.focusReturn]);

  const live = <p className="approval-live visually-hidden" role="status" aria-live="polite">{state.announcement}</p>;
  if (!state.open) return live;
  const busy = (which) => state.sending === which;
  return <>
    {live}
    <aside className="approval-panel" role="complementary" aria-label={state.ariaLabel}>
      <header className="approval-head">
        <div>
          <p className="approval-overline">Permission request</p>
          <h2>{state.heading}</h2>
          <p className="approval-meta">{state.meta}</p>
          <p className="approval-waiting"><span className="approval-lantern" aria-hidden="true" />Waiting on you</p>
        </div>
        <div className="approval-head-side">
          {state.expiresLabel ? <p className="approval-expires">{state.expiresLabel}</p> : null}
          <button type="button" className="approval-close" ref={refs.close} aria-label="Close permission request" onClick={review.close}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" /></svg>
          </button>
        </div>
      </header>
      <div className="approval-body">
        <p className="approval-label"><span>{state.questions ? 'Questions' : 'Tool input'}</span><span>{state.countLabel}</span></p>
        <div className="approval-well" tabIndex={0} role="region" aria-label="Tool input">
          {state.questions ? <QuestionFields questions={state.questions} picks={state.picks} disabled={state.noteReadOnly}
            onPick={review.pickAnswer} onOther={review.writeAnswer} />
            : state.inputView?.kind === "tickets" ? <TicketsInput view={state.inputView} raw={state.inputText} />
            : state.inputText !== null ? <pre className="approval-input">{state.inputText}</pre>
            : state.phase === "loading" ? <div className="approval-skeleton" aria-hidden="true"><i /><i /><i /></div> : null}
        </div>
        {state.banner ? <p className="approval-banner" role="alert">{state.banner}</p> : null}
        {state.phase === "load-failed" ? <button type="button" className="approval-retry" onClick={review.retryLoad}>Load again</button> : null}
        <label className="approval-note">
          <span>Note to the agent (optional)</span>
          <input type="text" maxLength={NOTE_MAX} value={state.note} readOnly={state.noteReadOnly} aria-describedby="approval-note-help"
            onChange={(e) => review.setNote(e.target.value)} />
          <span id="approval-note-help" className="approval-note-help"><span>One line, sent with your answer</span><span>{state.noteCounter}</span></span>
        </label>
      </div>
      <footer className="approval-foot">
        <button type="button" className="approval-deny" ref={refs.deny} disabled={!state.denyEnabled} onClick={() => review.press("deny")}>
          {busy("deny") ? <><span className="approval-spinner" aria-hidden="true" />Sending</> : <>{state.questions ? 'Dismiss' : 'Deny'} <kbd>Q</kbd></>}
        </button>
        <button type="button" className="approval-allow" ref={refs.allow} disabled={!state.allowEnabled} onClick={() => review.press("allow")}>
          {busy("allow") ? <><span className="approval-spinner" aria-hidden="true" />Sending</> : <>{state.questions ? 'Send answers' : 'Allow'} <kbd>E</kbd></>}
        </button>
      </footer>
    </aside>
  </>;
}

// den-mvp/55: Bao's board_file batch, as the tickets it files. The raw input stays one click away.
export function TicketsInput({ view, raw }) {
  const n = view.tickets.length;
  return (
    <div className="approval-tickets">
      <p className="approval-tickets-head">File {n} ticket{n === 1 ? "" : "s"} in <code>{view.feature}</code>, each at ready-for-human</p>
      <ol>
        {view.tickets.map((t) => (
          <li key={t.n} className="approval-ticket">
            <details>
              <summary>
                <span className="approval-ticket-title">{t.title}</span>
                <span className="approval-ticket-meta">{[t.priority, t.type, t.blockedBy.length ? `after ${t.blockedBy.join(", ")}` : null].filter(Boolean).join(" · ")}</span>
              </summary>
              <AgentMarkdown text={t.text} />
            </details>
          </li>
        ))}
      </ol>
      <details className="approval-raw">
        <summary>Raw input</summary>
        <pre className="approval-input">{raw}</pre>
      </details>
    </div>
  );
}
