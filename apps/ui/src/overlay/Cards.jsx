// The floating cards over the scene (den-scene-v1/07, digest 2026-10-01-iso-den.md section 4): the logo pill top-left,
// and on the right a Needs you card and a Teams & queue card, each collapsible from its header.
// Agent text (ticket titles) is untrusted: everything renders as React text nodes, never as HTML.
import { QueueDrawer } from "./QueueDrawer.jsx";
import { Sheet } from "../shell/Sheet.jsx";
import { SHEET_HEADS } from "../shell/rail-model.mjs";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { noteCounter, submitGate } from "../panel/gates-model.mjs";
import { DemoBadge } from "../demo/DemoControls.jsx";
import { createBridgeClient } from "../state/bridge-client.mjs";
import { TEAM_HUE, badgeModel, needsYouModel, teamsModel, stepRequest } from "./overlay-model.mjs";
import { deliverState, deliveryRows } from "./delivery-model.mjs";
import { behindLine, buildLine, newVersionReady, rollbackState } from "./build-model.mjs";
import { Card } from "./Card.jsx";
import { LibraryCard } from "./Library.jsx";
import { MeetingSheet, MeetingsCard, useMeetings } from "./Meetings.jsx";
import { meetingRows } from "./meeting-model.mjs";
import { ROLE_OPTIONS, capacityFromSnapshot, defaultRole, dispatchPrompt, runState, slotRows } from "./run-model.mjs";

const isTextField = (el) => el instanceof Element && (el.closest("input, textarea, select, [contenteditable]") !== null);

function PandaFace() {
  return (
    <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true" className="portrait-face">
      <circle cx="9" cy="10" r="5.5" fill="var(--panda-ink)" />
      <circle cx="31" cy="10" r="5.5" fill="var(--panda-ink)" />
      <circle cx="20" cy="22" r="13" fill="var(--panda-fur)" />
      <ellipse cx="14.5" cy="20" rx="3.4" ry="4.4" fill="var(--panda-ink)" transform="rotate(18 14.5 20)" />
      <ellipse cx="25.5" cy="20" rx="3.4" ry="4.4" fill="var(--panda-ink)" transform="rotate(-18 25.5 20)" />
      <ellipse cx="20" cy="26" rx="2.2" ry="1.5" fill="var(--panda-ink)" />
    </svg>
  );
}

export function LogoPill({ connection, demo = false }) {
  const badge = badgeModel(connection);
  return (
    <header className="logo-pill" data-overlay="logo">
      <span className="logo-face" aria-hidden="true"><PandaFace /></span>
      <h1>Dim Sum Dev</h1>
      {demo ? <DemoBadge /> : <span className={`live-badge live-${badge.tone}`} aria-live={badge.ariaLive ?? undefined}>
        <span className="live-dot" aria-hidden="true" />
        <span>{badge.label}</span>
        {badge.hint ? <span className="visually-hidden">{`. ${badge.hint}`}</span> : null}
      </span>}
    </header>
  );
}

const Decision = forwardRef(function Decision({ request, session }, ref) {
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [locked, setLocked] = useState(false);
  const [sending, setSending] = useState(null);
  const inflight = useRef(new Set());
  const noteField = useRef(null);
  const counter = noteCounter(note.length);

  const send = useCallback(async (kind) => {
    if (inflight.current.has(kind)) return;
    inflight.current.add(kind);
    setSending(kind);
    setError(null);
    const r = await submitGate({ fetch: session.fetch, ref: request.ref, kind, note });
    inflight.current.delete(kind);
    setSending(null);
    if (!r.ok) {
      setError(r.message);
      if (!r.retryable) setLocked(true);
    }
  }, [request.ref, note, session]);

  const canAct = !locked && !request.pending;
  useImperativeHandle(ref, () => ({
    approve: () => { if (canAct) send(request.approveKind); },
    deny: () => { if (canAct) send(request.rejectKind); },
    focusNote: () => noteField.current?.focus(),
  }), [canAct, send, request.approveKind, request.rejectKind]);
  // Deny with message: Ctrl or Cmd + Enter in the Note denies with that note. Plain Enter adds a line.
  const onNoteKeyDown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && canAct) {
      e.preventDefault();
      send(request.rejectKind);
    }
  };

  if (request.pending) {
    return <p className="small gate-pending" aria-live="polite">{request.pending.text}</p>;
  }
  return (
    <div aria-live="polite">
      <label className="note-label" htmlFor="needs-note">Note<kbd aria-hidden="true">m</kbd></label>
      <textarea id="needs-note" ref={noteField} className="note-field" rows={2} maxLength={500} placeholder="Optional" aria-describedby="needs-note-help" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={onNoteKeyDown} />
      <p id="needs-note-help" className="small muted note-help">Ctrl Enter denies with this note</p>
      {counter.show ? <p className="small muted">{counter.text}</p> : null}
      <div className="decision-buttons">
        <button type="button" className="btn btn-solid" aria-keyshortcuts="a" disabled={locked} onClick={() => send(request.approveKind)}>
          {sending === request.approveKind ? "Sending…" : "Approve"}<kbd aria-hidden="true">a</kbd>
        </button>
        <button type="button" className="btn btn-outline" aria-keyshortcuts="d" disabled={locked} onClick={() => send(request.rejectKind)}>
          {sending === request.rejectKind ? "Sending…" : "Deny"}<kbd aria-hidden="true">d</kbd>
        </button>
      </div>
      {error ? <p className="small gate-error">{error}</p> : null}
    </div>
  );
});

// den-v1 loop: a permission request the bridge holds. Both buttons open the permission review, which shows the full
// tool input and sends the answer (ADR 0016 decision 6); nothing is sent from this card. E and Q are bound in App.
function PermissionDecision({ request, onAnswer, onOpenThread }) {
  // No onAnswer: Demo mode, where nothing can be answered.
  const hint = onAnswer ? "Opens the permission request" : "Demo mode: actions are off";
  return (
    <div aria-live="polite">
      <p className="small muted needs-expires">
        {request.expires}
        {onOpenThread ? <button type="button" className="btn btn-outline needs-thread" onClick={() => onOpenThread(request.card)}>Open thread</button> : null}
      </p>
      <div className="decision-buttons">
        <button type="button" className="btn btn-outline" data-answer="deny" aria-keyshortcuts="q" title={hint} disabled={!onAnswer} onClick={() => onAnswer?.(request.card)}>
          Deny<kbd aria-hidden="true">Q</kbd>
        </button>
        <button type="button" className="btn btn-solid" data-answer="allow" aria-keyshortcuts="e" title={hint} disabled={!onAnswer} onClick={() => onAnswer?.(request.card)}>
          Allow<kbd aria-hidden="true">E</kbd>
        </button>
      </div>
    </div>
  );
}

// organism-infra/228: Run starts an agent for a frontier ticket. The state that must outlive a row (a start in flight,
// the last refusal, the usage note) lives here, once, so the Teams row and the Needs you dispatch card agree.
const RUN_NOTICE = "Started. Usage reading unavailable.";
const refusalText = (e) => `Couldn't run: ${e?.status ? `${e.status} ` : ""}${e?.reason ?? "the bridge refused the request."}`;
const without = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([k, v]) => keep(k, v)));

export function useRunner(client) {
  const pending = useRef(new Set());
  const [inflight, setInflight] = useState(() => new Set());
  const [results, setResults] = useState({}); // ref -> { error } | { notice }
  const clear = useCallback((ref) => setResults((r) => (ref in r ? without(r, (k) => k !== ref) : r)), []);
  const start = useCallback(async (ref, role) => {
    if (pending.current.has(ref)) return; // one start per ref at a time; a second press while one is out is not a second request
    pending.current.add(ref);
    setInflight(new Set(pending.current));
    setResults((r) => without(r, (k, v) => k !== ref && !v.notice)); // the next press clears this ref's error and old notes
    try {
      const body = await client.dispatch(ref, { role });
      if (body?.usageUnknown === true) setResults((r) => ({ ...r, [ref]: { notice: RUN_NOTICE } }));
    } catch (e) {
      setResults((r) => ({ ...r, [ref]: { error: refusalText(e) } }));
    } finally {
      pending.current.delete(ref);
      setInflight(new Set(pending.current));
    }
  }, [client]);
  return useMemo(() => ({ inflight, results, start, clear }), [inflight, results, start, clear]);
}

// den-mvp outcome 3: deliveries. One request per key (a ticket ref, a delivery id, or "new" for a typed task) at a time;
// the last refusal for a key stays until its next press.
export function useDeliveries(client) {
  const pending = useRef(new Set());
  const [inflight, setInflight] = useState(() => new Set());
  const [results, setResults] = useState({});
  const call = useCallback(async (key, fn) => {
    if (pending.current.has(key)) return false;
    pending.current.add(key);
    setInflight(new Set(pending.current));
    setResults((r) => without(r, (k) => k !== key));
    try {
      await fn();
      return true;
    } catch (e) {
      setResults((r) => ({ ...r, [key]: { error: `Couldn't do that: ${e?.status ? `${e.status} ` : ""}${e?.reason ?? "the bridge refused the request."}` } }));
      return false;
    } finally {
      pending.current.delete(key);
      setInflight(new Set(pending.current));
    }
  }, []);
  const deliver = useCallback((ref) => call(ref, () => client.deliver({ ref })), [call, client]);
  const deliverText = useCallback((text) => call("new", () => client.deliver({ text })), [call, client]);
  const steer = useCallback((id, action, options) => call(id, () => client.steerDelivery(id, action, options)), [call, client]);
  const answerTicket = useCallback((ref, action, options) => call(`ticket:${ref}`, () => client.answerTicket(ref, action, options)), [call, client]);
  const runChecks = useCallback((pr) => call(`checks:${pr}`, () => client.runChecks({ pr })), [call, client]);
  const dismissRouterStop = useCallback((id) => call(`router-stop:${id}`, () => client.dismissRouterStop(id)), [call, client]);
  return useMemo(() => ({ inflight, results, deliver, deliverText, steer, runChecks, answerTicket, dismissRouterStop }), [inflight, results, deliver, deliverText, steer, runChecks, answerTicket, dismissRouterStop]);
}

const idPart = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");

/** Deliver for one ticket: the whole software path, started by this press. Shown only for a ticket that is software. */
function DeliverControl({ scope, ticket, snapshot, steer, deliveries }) {
  const inflight = deliveries.inflight.has(ticket.ref);
  const state = deliverState({ ticket, snapshot, steer, inflight });
  if (!state.show) return null;
  const id = `${scope}-${idPart(ticket.ref)}-deliver`;
  const error = deliveries.results[ticket.ref]?.error;
  return (
    <div className="run">
      <div className="run-controls">
        <button type="button" className="btn btn-outline run-btn" title="Developer, qa, the checks, a pull request, the merge" aria-label={`Deliver ${ticket.ref}`} aria-busy={inflight || undefined} aria-describedby={state.reason ? `${id}-reason` : undefined} disabled={!state.enabled} onClick={() => deliveries.deliver(ticket.ref)}>
          {inflight ? "Starting…" : "Deliver"}
        </button>
      </div>
      {state.reason && !inflight ? <p id={`${id}-reason`} className="small muted run-reason">{state.reason}</p> : null}
      {error ? <p className="small gate-error" role="alert">{error}</p> : null}
    </div>
  );
}

// den-mvp/34: the checks run on this machine beside GitHub's, for one commit. Closed, it is one line; open, it shows the
// exact commands, what of this machine differs from GitHub's runner, the failing and flaky tests, and where the record is.
function ChecksDetail({ view }) {
  if (!view) return null;
  return (
    <details className={`checks-detail${view.mismatch ? " checks-mismatch" : ""}`}>
      <summary className="small">{view.summary}</summary>
      {view.mismatch ? <p className="small checks-warn">The two runs disagree on the same commit. The cause is often one of the differences below.</p> : null}
      {view.reason ? <p className="small">{view.reason}</p> : null}
      {view.commands.length ? <><p className="small muted">Commands, each in a box on this machine</p><pre className="code-well"><code>{view.commands.join("\n")}</code></pre></> : null}
      {view.differences.length ? <><p className="small muted">This machine differs from GitHub&apos;s runner in</p><ul className="small checks-list">{view.differences.map((d) => <li key={d}>{d}</li>)}</ul></> : null}
      {view.failed.length ? <><p className="small muted">Failing here</p><ul className="small checks-list">{view.failed.map((f) => <li key={f}>{f}</li>)}</ul></> : null}
      {view.flaky.length ? <><p className="small muted">Flaky: failed, then passed on the same commit</p><ul className="small checks-list">{view.flaky.map((f) => <li key={f}>{f}</li>)}</ul></> : null}
      {view.record ? <p className="small muted">Record: <span className="code-small">{view.record}</span></p> : null}
    </details>
  );
}

// A delivery that waits on the user (Needs you). Resume asks the bridge to look again and go on; Close ends it for good.
// den-mvp/12: a UI change waits with a link to its preview; Approve covers the merge and going live, and Decline sends
// it back to the developer with the note.
// den-mvp/29: a red pull request has nothing to approve here: what to do, and the link to it.
function CiNote({ request, steer, deliveries }) {
  const off = steer?.demo ? "Demo mode: actions are off" : steer?.state === "none" ? "Not signed in to steer" : null;
  const key = `checks:${request.prNumber}`;
  const busy = request.checksRunning || deliveries?.inflight.has(key);
  const error = deliveries?.results[key]?.error;
  return (
    <div aria-live="polite">
      <p className="small needs-expires">{request.next}</p>
      {request.pr ? <p className="small"><a href={request.pr} target="_blank" rel="noreferrer noopener">Open pull request #{request.prNumber}</a></p> : null}
      <ChecksDetail view={request.checks} />
      {deliveries && request.canRunChecks ? (
        <div className="run-controls">
          <button type="button" className="btn btn-outline run-btn" title={off ?? "Runs the commands of ci.yml on this machine, in a box, on the pull request's commit"} disabled={!!off || busy} aria-busy={busy || undefined} onClick={() => deliveries.runChecks(request.prNumber)}>
            {busy ? "Running the checks here…" : "Run the checks here"}
          </button>
        </div>
      ) : null}
      {error ? <p className="small gate-error" role="alert">{error}</p> : null}
    </div>
  );
}

// den-mvp/88: a stop the router met. Nothing to approve: Dismiss says the user has seen it.
function RouterStopNote({ request, steer, deliveries }) {
  const off = steer.demo ? "Demo mode: actions are off" : steer.state === "none" ? "Not signed in to steer" : null;
  const busy = deliveries.inflight.has(`router-stop:${request.id}`);
  const error = deliveries.results[`router-stop:${request.id}`]?.error;
  return (
    <div aria-live="polite">
      <div className="decision-buttons">
        <button type="button" className="btn btn-outline" aria-label={`Dismiss ${request.short}`} title={off ?? undefined} disabled={!!off || busy} aria-busy={busy || undefined} onClick={() => deliveries.dismissRouterStop(request.id)}>Dismiss</button>
      </div>
      {off ? <p className="small muted">{off}</p> : null}
      {error ? <p className="small gate-error" role="alert">{error}</p> : null}
    </div>
  );
}

// den-mvp/13: a ticket waiting at ready-for-human. The text is in the card above; Decline needs the reason.
function TicketDecision({ request, steer, deliveries }) {
  const off = steer.demo ? "Demo mode: actions are off" : steer.state === "none" ? "Not signed in to steer" : null;
  const key = `ticket:${request.ref}`;
  const busy = deliveries.inflight.has(key);
  const error = deliveries.results[key]?.error;
  const [note, setNote] = useState("");
  const noteId = `ticket-note-${idPart(request.ref)}`;
  return (
    <div aria-live="polite">
      <label className="note-label" htmlFor={noteId}>To decline, say why</label>
      <textarea id={noteId} className="note-field" rows={2} maxLength={500} value={note} disabled={!!off || busy} onChange={(e) => setNote(e.target.value)} />
      <div className="decision-buttons">
        <button type="button" className="btn btn-outline" aria-label={`Decline ${request.short}`} title={off ?? (note.trim() ? undefined : "Write why first")} disabled={!!off || busy || !note.trim()} onClick={() => deliveries.answerTicket(request.ref, "decline", { note })}>Decline</button>
        <button type="button" className="btn btn-solid" aria-label={`Approve ${request.short}`} title={off ?? undefined} disabled={!!off || busy} aria-busy={busy || undefined} onClick={() => deliveries.answerTicket(request.ref, "approve")}>Approve</button>
      </div>
      {off ? <p className="small muted">{off}</p> : null}
      {error ? <p className="small gate-error" role="alert">{error}</p> : null}
    </div>
  );
}

function DeliveryDecision({ request, steer, deliveries }) {
  const off = steer.demo ? "Demo mode: actions are off" : steer.state === "none" ? "Not signed in to steer" : null;
  const busy = deliveries.inflight.has(request.id);
  const error = deliveries.results[request.id]?.error;
  const [note, setNote] = useState("");
  const noteId = `decline-note-${idPart(request.id)}`;
  // A plain Resume can carry a note: the next run that starts reads it first.
  const resumeNote = !request.decline && request.primary.action === "resume" && !request.primary.verdict;
  return (
    <div aria-live="polite">
      {request.next ? <p className="small needs-expires">{request.next}</p> : null}
      {request.covers ? <p className="small">{request.covers}</p> : null}
      {request.rolledBackNote ? <p className="small build-behind">{request.rolledBackNote}</p> : null}
      {request.previewUrl ? <p className="small"><a href={request.previewUrl} target="_blank" rel="noreferrer noopener">Open the preview of {request.short} in a new tab</a></p> : null}
      {request.lookAt?.length ? (
        <div className="look-at">
          <p className="note-label">What to look at</p>
          <ul className="small">{request.lookAt.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </div>
      ) : null}
      {request.pr ? <p className="small"><a href={request.pr} target="_blank" rel="noreferrer noopener">Open pull request #{request.prNumber}</a></p> : null}
      <ChecksDetail view={request.checks} />
      {request.decline ? (
        <>
          <label className="note-label" htmlFor={noteId}>To decline, say what should change</label>
          <textarea id={noteId} className="note-field" rows={2} maxLength={1000} value={note} disabled={!!off || busy} onChange={(e) => setNote(e.target.value)} />
        </>
      ) : resumeNote ? (
        <>
          <label className="note-label" htmlFor={noteId}>Note for the next run (optional)</label>
          <textarea id={noteId} className="note-field" rows={2} maxLength={1000} value={note} disabled={!!off || busy} onChange={(e) => setNote(e.target.value)} />
        </>
      ) : null}
      <div className={request.decline ? "decision-buttons decision-three" : "decision-buttons"}>
        <button type="button" className="btn btn-outline" title={off ?? undefined} disabled={!!off || busy} onClick={() => deliveries.steer(request.id, "close")}>Close delivery</button>
        {request.decline ? (
          <button type="button" className="btn btn-outline" aria-label={`Decline ${request.short} and send it back to the developer`} title={off ?? (note.trim() ? undefined : "Write what should change first")} disabled={!!off || busy || !note.trim()} onClick={() => deliveries.steer(request.id, "resume", { verdict: "decline", note })}>Decline</button>
        ) : null}
        <button type="button" className="btn btn-solid" title={off ?? undefined} disabled={!!off || busy} aria-busy={busy || undefined} onClick={() => deliveries.steer(request.id, request.primary.action, request.primary.verdict ? { verdict: request.primary.verdict } : resumeNote && note.trim() ? { note } : undefined)}>
          {request.primary.label}
        </button>
      </div>
      {off && request.decline ? <p className="small muted">{off}</p> : null}
      {error ? <p className="small gate-error" role="alert">{error}</p> : null}
    </div>
  );
}

// A meeting that waits on the user (Needs you). A paused one is resumed or closed here; a brief is opened in the Meetings card.
function MeetingDecision({ request, steer, meetings, onOpenMeeting }) {
  const off = steer.demo ? "Demo mode: actions are off" : steer.state === "none" ? "Not signed in to steer" : null;
  const busy = meetings.inflight.has(request.id);
  const error = meetings.results[request.id]?.error;
  const open = request.primary.action === "open";
  return (
    <div aria-live="polite">
      {request.next ? <p className="small needs-expires">{request.next}</p> : null}
      <div className="decision-buttons">
        <button type="button" className="btn btn-outline" title={off ?? undefined} disabled={!!off || busy} onClick={() => meetings.steer(request.id, "close")}>Close meeting</button>
        <button type="button" className="btn btn-solid" title={open ? undefined : off ?? undefined} disabled={open ? false : !!off || busy} aria-busy={busy || undefined} onClick={() => (open ? onOpenMeeting(request.id) : meetings.steer(request.id, "resume"))}>
          {request.primary.label}
        </button>
      </div>
      {error ? <p className="small gate-error" role="alert">{error}</p> : null}
    </div>
  );
}

// den-mvp/12 (ADR 0026 decisions 7 to 9): which build is live, a notice when another one went live while this page was
// open, and the way back to the previous build. Shown only when the den is served from a release. The page never
// reloads by itself.
function BuildStatus({ snapshot, ownBuild, steer, client }) {
  const build = snapshot?.build ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const line = buildLine(build);
  if (!line) return null;
  const back = rollbackState({ build, steer, inflight: busy });
  const behind = behindLine(build);
  const goBack = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.rollback(back.to);
    } catch (e) {
      setError(`Couldn't go back: ${e?.status ? `${e.status} ` : ""}${e?.reason ?? "the bridge refused the request."}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="build-status" data-overlay="build" aria-label="The den's build">
      <p className="small build-line">{line}</p>
      {behind ? <p className="small build-behind">{behind}</p> : null}
      {newVersionReady(ownBuild, build) ? (
        <div className="build-new" role="status">
          <p className="small">A new version is ready.</p>
          <button type="button" className="btn btn-solid" aria-label="Reload the den to the new version" onClick={() => window.location.reload()}>Reload</button>
        </div>
      ) : null}
      {back.show ? (
        <div className="build-back">
          <button type="button" className="btn btn-outline" aria-label={back.name} aria-describedby="build-back-detail" aria-busy={busy || undefined} disabled={!back.enabled} onClick={goBack}>Go back to the previous build</button>
          <p id="build-back-detail" className="small muted">{back.detail}{back.reason ? ` ${back.reason}.` : ""}</p>
        </div>
      ) : null}
      {error ? <p className="small gate-error" role="alert">{error}</p> : null}
    </section>
  );
}

/** The deliveries under way and the newest ended, and a box to deliver a change that has no ticket yet. */
function DeliveriesSection({ snapshot, steer, deliveries }) {
  const rows = deliveryRows(snapshot);
  const [text, setText] = useState("");
  const off = steer.demo ? "Demo mode: actions are off" : steer.state === "none" ? "Couldn't send: not signed in to steer" : null;
  const sending = deliveries.inflight.has("new");
  const send = async () => {
    if (await deliveries.deliverText(text)) setText("");
  };
  return (
    <section className="deliveries" aria-label="Deliveries">
      <div className="slots-head">
        <span className="ov">Deliveries</span>
        <span className="small">{rows.filter((r) => r.state === "running").length} running</span>
      </div>
      {rows.length > 0 ? (
        <ul className="queue-rows">
          {rows.map((r) => (
            <li key={r.id} className="queue-row" data-delivery={r.state}>
              <div className="queue-line">
                <span className="queue-title">{r.title}</span>
              </div>
              <span className="code-small muted queue-ref">{r.ref}</span>
              <p className="small">{r.line}{r.pr ? <> · <a href={r.pr} target="_blank" rel="noreferrer noopener">pull request #{r.prNumber}</a></> : null}</p>
              {r.facts.length > 0 ? <p className="small muted">{r.facts.join(" · ")}</p> : null}
              <ChecksDetail view={r.checks} />
              {r.canStop ? <button type="button" className="btn btn-outline run-btn" aria-label={`Stop delivery of ${r.ref}`} disabled={!!off || deliveries.inflight.has(r.id)} onClick={() => deliveries.steer(r.id, "stop")}>Stop delivery</button> : null}
              {deliveries.results[r.id]?.error && r.state !== "paused" ? <p className="small gate-error" role="alert">{deliveries.results[r.id].error}</p> : null}
            </li>
          ))}
        </ul>
      ) : <p className="small muted">Nothing is being delivered.</p>}
      <label className="note-label" htmlFor="deliver-new">Deliver a change with no ticket yet</label>
      <textarea id="deliver-new" className="note-field" rows={2} maxLength={2000} value={text} disabled={!!off || sending} placeholder="What to build, and how you will know it is done" onChange={(e) => setText(e.target.value)} />
      <p className="small muted">{off ?? "Writes a ticket, then runs developer, qa, the checks and the merge."}</p>
      <div className="run-controls">
        <button type="button" className="btn btn-outline run-btn" disabled={!!off || sending} aria-busy={sending || undefined} onClick={send}>{sending ? "Starting…" : "Deliver"}</button>
      </div>
      {deliveries.results.new?.error ? <p className="small gate-error" role="alert">{deliveries.results.new.error}</p> : null}
    </section>
  );
}

/** Role select, Run, and the lines under them for one ticket: the disabled reason, a refusal, the usage note. */
function RunControl({ scope, ticket, capacity, steer, run }) {
  const [role, setRole] = useState(() => defaultRole(ticket));
  const ref = ticket.ref;
  const inflight = run.inflight.has(ref);
  const state = runState({ capacity, ticket, inflight, steer, role });
  const settled = runState({ capacity, ticket, inflight: false, steer, role });
  // The refusal clears when this row's state changes (an agent started or ended, the session ended), not only on the next press.
  const signature = `${settled.enabled}|${settled.reason}`;
  const seen = useRef(signature);
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    run.clear(ref);
  }, [signature, ref, run]);

  const id = `${scope}-${idPart(ref)}`;
  const result = run.results[ref] ?? {};
  const showReason = state.reason && !inflight;
  return (
    <div className="run">
      <div className="run-controls">
        <label className="small muted run-label" htmlFor={`${id}-role`}>Role</label>
        <select id={`${id}-role`} className="run-select" value={role} disabled={!state.enabled} onChange={(e) => setRole(e.target.value)}>
          {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button
          type="button"
          className="btn btn-solid run-btn"
          aria-label={`Run ${ref}`}
          aria-busy={inflight || undefined}
          aria-describedby={showReason ? `${id}-reason` : undefined}
          title={steer.demo ? "Demo mode: actions are off" : undefined}
          disabled={!state.enabled}
          onClick={() => run.start(ref, role)}
        >
          {inflight ? "Starting…" : "Run"}
        </button>
      </div>
      {showReason ? <p id={`${id}-reason`} className="small muted run-reason">{state.reason}</p> : null}
      {result.error ? <p className="small gate-error" role="alert">{result.error}</p> : null}
      {result.notice ? <p className="small muted">{result.notice}</p> : null}
    </div>
  );
}

/** The slot strip: one row per ref holding a slot, a live agent told from a lock by glyph, word and border, never hue alone. */
function SlotStrip({ snapshot, capacity }) {
  const rows = slotRows(capacity, snapshot?.agents);
  return (
    <section className="slots" aria-label="Slots">
      <div className="slots-head">
        <span className="ov">Slots</span>
        <span className="small">
          {!snapshot ? "Slots unavailable, bridge offline" : !capacity ? "Capacity unknown" : `${capacity.load} of ${capacity.max} running`}
        </span>
      </div>
      {rows.length > 0 ? (
        <ul className="slot-rows">
          {rows.map((r) => (
            <li key={r.ref} className="slot-row">
              <span className="visually-hidden">{r.label}</span>
              <span className={`slot-pip slot-pip-${r.kind}`} aria-hidden="true">{r.kind === "live" ? "▶" : "◌"}</span>
              <span className="code-small slot-ref" aria-hidden="true">{r.ref}</span>
              <span className={`slot-tag slot-tag-${r.kind}`} aria-hidden="true">{r.tag}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.some((r) => r.kind === "lock") ? <p className="small muted slots-note">A lock with no agent costs a slot until it is reclaimed on the board.</p> : null}
    </section>
  );
}

export function NeedsYouCard({ snapshot, now, open, onToggle, busy, placeholder, session, onAnswer, onOpenThread = null, capacity = null, steer = { state: "ready" }, run = null, deliveries = null, meetings = null, onOpenMeeting = () => {} }) {
  const { count, requests } = needsYouModel(snapshot, now);
  const [shown, setShown] = useState(null);
  const current = requests.find((r) => r.key === shown) ?? requests[0] ?? null;
  const decision = useRef(null);
  // 228: a dispatch gate also gets Run, and at room 0 its prompt (note, Approve, Deny) is replaced by one line.
  const isDispatch = current?.kind === "gate" && current.gate === "dispatch";
  const prompt = isDispatch ? dispatchPrompt(capacity) : { show: true, line: null };
  const dispatchTicket = isDispatch ? (snapshot?.tickets ?? []).find((t) => t.ref === current.ref) ?? { ref: current.ref } : null;

  // Card-scoped keys: only while focus is inside this card and not in a text field. The Tally dialog and the
  // scene are outside it, so a, d, m, j and k never reach them from here or here from them.
  const onKeyDown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTextField(e.target) || !current) return;
    if (!prompt.show && (e.key === "a" || e.key === "d" || e.key === "m")) return; // no prompt on screen, so these keys do nothing
    if (e.key === "a") decision.current?.approve();
    else if (e.key === "d") decision.current?.deny();
    else if (e.key === "m") decision.current?.focusNote();
    else if (e.key === "j" || e.key === "k") {
      setShown(stepRequest(requests, current.key, e.key === "j" ? 1 : -1));
      e.currentTarget.focus({ preventScroll: true });
    }
    else return;
    e.preventDefault();
  };

  const others = current ? requests.filter((r) => r.key !== current.key) : [];
  return (
    <div onKeyDown={onKeyDown} tabIndex={-1} className="card-wrap">
      <Card
        id="needs-you"
        overlay="needs-you"
        label={count > 0 ? `Needs you, ${count} waiting` : "Needs you"}
        edge={count > 0 ? "lantern" : "line"}
        open={open}
        onToggle={onToggle}
        title="Needs you"
        aside={count > 0 ? <span className="count-pill">{count}</span> : null}
        busy={busy}
      >
        {placeholder ? <p className="muted">{placeholder}</p> : null}
        {!placeholder && !current ? <p className="muted">Nothing is waiting on you.</p> : null}
        {current ? (
          <>
            <div className="needs-head" aria-live="polite">
              <span className="portrait" style={{ "--zone": `var(${TEAM_HUE[current.team]}-zone)` }} aria-hidden="true"><PandaFace /></span>
              <div className="needs-text">
                <p className="eyebrow">{current.eyebrow}</p>
                <p className="needs-title">{current.title}</p>
              </div>
            </div>
            {current.reason ? <p className={`needs-reason${current.reasonFallback ? " muted needs-reason-none" : ""}`}>{current.reasonFallback || current.plain ? current.reason : <q>{current.reason}</q>}</p> : null}
            {current.preview.length > 0 ? <pre className="code-well" aria-label={current.detailLabel}><code>{current.preview.join("\n")}</code></pre> : null}
            {isDispatch && run ? <RunControl key={`run-${current.key}`} scope="dispatch" ticket={dispatchTicket} capacity={capacity} steer={steer} run={run} /> : null}
            {current.kind === "permission"
              ? <PermissionDecision key={current.key} request={current} onAnswer={onAnswer} onOpenThread={onOpenThread} />
              : current.kind === "delivery"
                ? (deliveries ? <DeliveryDecision key={current.key} request={current} steer={steer} deliveries={deliveries} /> : null)
              : current.kind === "ci"
                ? <CiNote key={current.key} request={current} steer={steer} deliveries={deliveries} />
              : current.kind === "ticket"
                ? (deliveries ? <TicketDecision key={current.key} request={current} steer={steer} deliveries={deliveries} /> : null)
              : current.kind === "router-stop"
                ? (deliveries ? <RouterStopNote key={current.key} request={current} steer={steer} deliveries={deliveries} /> : null)
              : current.kind === "meeting"
                ? (meetings ? <MeetingDecision key={current.key} request={current} steer={steer} meetings={meetings} onOpenMeeting={onOpenMeeting} /> : null)
              : prompt.show
                ? <Decision key={current.key} ref={decision} request={current} session={session} />
                : <p className="small muted dispatch-line">{prompt.line}</p>}
            {others.length > 0 ? (
              <ul className="request-rows">
                {others.map((r) => (
                  <li key={r.key}>
                    <button type="button" className="request-row" onClick={() => setShown(r.key)}>
                      <span className="request-row-text">{r.rowText}</span>
                      {r.age ? <span className="request-row-age">{r.age}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </Card>
    </div>
  );
}

export function TeamsCard({ snapshot, open, onToggle, busy, placeholder, onZoomTeam, capacity = null, steer = { state: "ready" }, run = null, deliveries = null }) {
  const m = teamsModel(snapshot);
  const listed = new Set(m.next.map((r) => r.ref));
  const notes = run ? Object.entries(run.results).filter(([ref, v]) => v.notice && !listed.has(ref)) : []; // the row left the list: say it here instead
  return (
    <Card
      id="teams"
      overlay="teams"
      label="Teams & queue"
      edge="line"
      open={open}
      onToggle={onToggle}
      title="Teams & queue"
      aside={<span className="card-summary">{m.summary}</span>}
      busy={busy}
    >
      {placeholder ? <p className="muted">{placeholder}</p> : null}
      <div className="pills">
        {m.open.map((s) => (
          <button key={s.id} type="button" className="pill-team" data-team-pill={s.id} style={{ "--hue": `var(${TEAM_HUE[s.id]})` }} onClick={() => onZoomTeam(s.id)}>
            <span className="team-dot" aria-hidden="true">{s.glyph}</span>
            <span className="team-name">{s.name}</span>
            <span className="team-count">{s.count}</span>
            {s.waiting ? <span className="team-waiting">· waiting</span> : null}
          </button>
        ))}
        {m.dormant.map((s) => (
          <span key={s.id} className="pill-team pill-dormant" data-team-pill={s.id}>
            <span className="team-glyph" aria-hidden="true">{s.glyph}</span>
            <span className="team-name">{s.name}</span>
            <span className="team-count">{s.text}</span>
          </span>
        ))}
      </div>
      <SlotStrip snapshot={snapshot} capacity={capacity} />
      {deliveries ? <DeliveriesSection snapshot={snapshot} steer={steer} deliveries={deliveries} /> : null}
      {notes.map(([ref, v]) => <p key={ref} className="small muted"><span className="code-small">{ref}</span> {v.notice}</p>)}
      <p className="ov">Next on the susan</p>
      {m.next.length === 0 ? (
        <p className="muted">The susan is empty.</p>
      ) : (
        <ul className="queue-rows queue-rows-flow">
          {m.next.map((r) => (
            <li key={r.ref} className="queue-row">
              <div className="queue-line">
                <span className="pchip" title={r.priority}>{r.priority}</span>
                <span className="queue-title">{r.title}</span>
              </div>
              <span className="code-small muted queue-ref">{r.ref}</span>
              {run ? <RunControl scope="teams" ticket={{ ref: r.ref, type: r.type }} capacity={capacity} steer={steer} run={run} /> : null}
              {deliveries ? <DeliverControl scope="teams" ticket={{ ref: r.ref, type: r.type }} snapshot={snapshot} steer={steer} deliveries={deliveries} /> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The right-hand column. Needs you opens by itself while something waits, until the user toggles it; Teams & queue,
 * Meetings and Library start closed. Under 600 px all start closed and opening one closes the others.
 */
/**
 * team-and-den-ux/04: the desk's cards, one at a time in the rail's topic sheet, and a meeting in the side sheet. It stays
 * mounted with nothing open, so the runner, the deliveries and the meetings keep their state across topics.
 *   topic: needs | queue | work | meetings | library | build | anything else (not this component's: renders no topic)
 *   meetingId: the meeting in the side sheet, or null; left: the meetings you left (their rows offer Rejoin)
 */
export function Cards({ snapshot, ownBuild = null, now, connection, placeholder, camera, steering, onAnswer, onOpenThread = null, onOpenTicket = null, demo = false,
  topic = null, onCloseTopic, onTopic, meetingId = null, meetingRole = null, onShowMeeting, onCloseMeeting, onLeaveMeeting, left = null }) {
  const busy = connection.phase !== "live";
  // 228: capacity is recomputed from the snapshot's agents and locks each render (the hub sends no capacity change frame).
  const client = useMemo(() => createBridgeClient({ fetch: steering.session.fetch }), [steering.session]);
  // The library is a read that needs no sign-in, so it does not go through the session: no credential is attached to it.
  const reader = useMemo(() => createBridgeClient({ fetch: (url, init) => fetch(url, init) }), []);
  const run = useRunner(client);
  const deliveries = useDeliveries(client);
  const meetings = useMeetings(client);
  const capacity = capacityFromSnapshot(snapshot);
  const steer = { state: steering.state, demo };
  // den-mvp/62: a queue row uses the same Run and Deliver controls as Work; a Needs-you row opens Needs you, where acting stays.
  const queueControls = (ticket) => (
    <>
      {run ? <RunControl scope="queue" ticket={ticket} capacity={capacity} steer={steer} run={run} /> : null}
      {deliveries ? <DeliverControl scope="queue" ticket={ticket} snapshot={snapshot} steer={steer} deliveries={deliveries} /> : null}
    </>
  );
  const head = SHEET_HEADS[topic];
  const meetingRow = meetingId ? meetingRows(snapshot).find((r) => r.id === meetingId) ?? null : null;
  const body = {
    needs: <NeedsYouCard snapshot={snapshot} now={now} open busy={busy} placeholder={placeholder} session={steering.session} onAnswer={onAnswer} onOpenThread={onOpenThread} capacity={capacity} steer={steer} run={run} deliveries={deliveries} meetings={meetings} onOpenMeeting={(id) => onShowMeeting?.(id, null)} />,
    queue: <QueueDrawer snapshot={snapshot} now={now} open inSheet onClose={onCloseTopic} onOpenNeeds={() => onTopic?.("needs")}
      onOpenTicket={onOpenTicket} controls={queueControls} />,
    work: <TeamsCard snapshot={snapshot} open busy={busy} placeholder={placeholder} onZoomTeam={(id) => camera.goToTeam(id)} capacity={capacity} steer={steer} run={run} deliveries={deliveries} />,
    meetings: <MeetingsCard client={client} snapshot={snapshot} open busy={busy} steer={steer} meetings={meetings} shown={meetingId} onShow={onShowMeeting} left={left} />,
    library: <LibraryCard client={reader} rev={snapshot?.libraryRev ?? 0} now={now} open busy={busy} demo={demo} />,
    build: buildLine(snapshot?.build ?? null) ? <BuildStatus snapshot={snapshot} ownBuild={ownBuild} steer={steer} client={client} /> : <p className="small muted">The bridge has not reported a build yet.</p>,
  }[topic];
  return (
    <>
      {body ? (
        <Sheet id="sheet-topic" slot="topic" eyebrow={head[0]} title={head[1]} closeLabel="Close panel" onClose={onCloseTopic} wide={topic === "queue"} focusKey={topic}>
          {steering.message ? <p className="small muted session-none" data-session="none" role="status">{steering.message}</p> : null}
          {body}
        </Sheet>
      ) : null}
      {meetingRow ? (
        <Sheet id="sheet-side" slot="side" eyebrow="Meeting" title={meetingRow.title} closeLabel="Close panel (the meeting keeps running)" onClose={onCloseMeeting} focusKey={meetingRow.id}>
          <MeetingSheet row={meetingRow} client={client} steer={steer} meetings={meetings} openRole={meetingRole} onLeave={onLeaveMeeting} />
        </Sheet>
      ) : null}
    </>
  );
}
