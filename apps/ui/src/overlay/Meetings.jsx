// den-mvp outcome 4: the Meetings card. Setup (a question and who to ask), progress (each seat and the chair), and the
// brief (the chair's text, the options to choose from, the takes, the follow-ups). Everything an agent wrote renders as
// React text, never as HTML. Choosing an option records the choice and writes proposed work; nothing is built by it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "./Card.jsx";
import { SEATS_MAX, SPECIALISTS, meetingRows, setupState, toggleRole } from "./meeting-model.mjs";

const SEAT_MARK = { taken: "●", declined: "–", failed: "▲", waiting: "○" }; // a shape per state, so colour is never the only cue
const errorText = (e) => `Couldn't do that: ${e?.status ? `${e.status} ` : ""}${e?.reason ?? "the bridge refused the request."}`;

/** One request per key (a meeting id, or "new") at a time; the last refusal for a key stays until its next press. */
export function useMeetings(client) {
  const pending = useRef(new Set());
  const [inflight, setInflight] = useState(() => new Set());
  const [results, setResults] = useState({});
  const call = useCallback(async (key, fn) => {
    if (pending.current.has(key)) return false;
    pending.current.add(key);
    setInflight(new Set(pending.current));
    setResults((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key)));
    try {
      await fn();
      return true;
    } catch (e) {
      setResults((r) => ({ ...r, [key]: { error: errorText(e) } }));
      return false;
    } finally {
      pending.current.delete(key);
      setInflight(new Set(pending.current));
    }
  }, []);
  const start = useCallback((body) => call("new", () => client.startMeeting(body)), [call, client]);
  const steer = useCallback((id, action, body) => call(id, () => client.steerMeeting(id, action, body)), [call, client]);
  // team-and-den-ux/04 (spec section 5): End meeting stops a running meeting and then closes it; the takes are kept.
  const end = useCallback((id, running) => call(id, async () => {
    if (running) await client.steerMeeting(id, "stop");
    await client.steerMeeting(id, "close");
  }), [call, client]);
  return useMemo(() => ({ inflight, results, start, steer, end }), [inflight, results, start, steer, end]);
}

/** End meeting…, then an inline confirm: End meeting / Keep it running (spec section 5). */
function EndMeeting({ row, meetings, off }) {
  const [asking, setAsking] = useState(false);
  const keep = useRef(null);
  const ask = setAsking;
  useEffect(() => { if (asking) keep.current?.focus({ preventScroll: true }); }, [asking]);
  if (!row.canEnd) return null;
  const acting = meetings.inflight.has(row.id);
  if (!asking) return <button type="button" className="btn btn-outline run-btn" title={off ?? undefined} disabled={!!off || acting} aria-label={`End the meeting ${row.title}`} onClick={() => ask(true)}>End meeting…</button>;
  return (
    <span className="meeting-confirm" role="group" aria-label={`End the meeting ${row.title}?`} data-confirm
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ask(false); } }}>
      <span className="small">End it? The takes are kept.</span>
      <button type="button" className="btn btn-solid run-btn" disabled={acting} onClick={async () => { if (await meetings.end(row.id, row.state === "running")) ask(false); }}>End meeting</button>
      <button type="button" ref={keep} className="btn btn-outline run-btn" onClick={() => ask(false)}>Keep it running</button>
    </span>
  );
}

function Setup({ snapshot, steer, meetings }) {
  const [topic, setTopic] = useState("");
  const [roles, setRoles] = useState([]);
  const [ref, setRef] = useState("");
  const inflight = meetings.inflight.has("new");
  const state = setupState({ topic, roles, usage: snapshot?.usage?.fiveHour ?? null, steer, inflight });
  const locked = !!steer.demo || steer.state === "none" || inflight;
  const send = async () => {
    if (await meetings.start({ topic, roles, ref })) { setTopic(""); setRoles([]); setRef(""); }
  };
  return (
    <section className="meeting-setup" aria-label="Start a meeting">
      <p className="ov">Start a meeting</p>
      <p className="small muted">Each role you pick gives one short take. Bao then writes a brief with two or three options, and you choose.</p>
      <label className="note-label" htmlFor="meeting-topic">The question</label>
      <textarea id="meeting-topic" className="note-field" rows={3} maxLength={2000} value={topic} disabled={locked} placeholder="What should be decided, and what matters most to you" onChange={(e) => setTopic(e.target.value)} />
      <fieldset className="meeting-roles" disabled={locked}>
        <legend className="note-label">Who to ask ({roles.length} of {SEATS_MAX})</legend>
        {SPECIALISTS.map((role) => (
          <label key={role} className="meeting-role">
            <input type="checkbox" checked={roles.includes(role)} disabled={!roles.includes(role) && roles.length >= SEATS_MAX} onChange={() => setRoles((r) => toggleRole(r, role))} />
            <span>{role}</span>
          </label>
        ))}
      </fieldset>
      <label className="note-label" htmlFor="meeting-ref">About a ticket (optional)</label>
      <input id="meeting-ref" className="note-field meeting-ref" type="text" maxLength={120} value={ref} disabled={locked} placeholder="feature/07-slug. Left empty, a discussion ticket is written." onChange={(e) => setRef(e.target.value)} />
      <p className="small muted" id="meeting-cost">{state.cost}</p>
      <div className="run-controls">
        <button type="button" className="btn btn-solid run-btn" disabled={!state.enabled} aria-busy={inflight || undefined} aria-describedby={`meeting-cost${state.reason ? " meeting-reason" : ""}`} onClick={send}>{inflight ? "Starting…" : "Start meeting"}</button>
      </div>
      {state.reason && !inflight ? <p id="meeting-reason" className="small muted run-reason">{state.reason}</p> : null}
      {meetings.results.new?.error ? <p className="small gate-error" role="alert">{meetings.results.new.error}</p> : null}
    </section>
  );
}

/** The saved texts of one meeting: loaded when its row is opened, and again whenever the bridge records a change to it. */
function Detail({ row, client, steer, meetings, openRole = null }) {
  const box = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState("");
  const [reask, setReask] = useState("");
  useEffect(() => {
    let current = true;
    client.getMeeting(row.id).then(
      (body) => { if (current) { setData(body); setError(null); } },
      (err) => { if (current) setError(err?.reason ?? "Could not load the meeting."); },
    );
    return () => { current = false; };
  }, [client, row.id, row.stamp]);
  const off = steer.demo ? "Demo mode: actions are off" : steer.state === "none" ? "Not signed in to steer" : null;
  const busy = meetings.inflight.has(row.id);
  const ask = async () => {
    if (await meetings.steer(row.id, "ask", { text, reask })) { setText(""); setReask(""); }
  };
  // den-mvp/64: opened from a seat at the table, the take is scrolled into view once it has loaded.
  useEffect(() => {
    if (!openRole || !data) return;
    box.current?.querySelector(`[data-take="${CSS.escape(openRole)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [openRole, data]);
  return (
    <div className="meeting-detail" ref={box}>
      {error ? <p className="small gate-error" role="alert">{error}</p> : null}
      {!data && !error ? <p className="small muted">Loading…</p> : null}
      {data?.topic ? (<><p className="ov">The question</p><p className="small meeting-quote">{data.topic}</p></>) : null}
      {data?.summary ? (<><p className="ov">Summary</p><pre className="code-well meeting-text">{data.summary}</pre></>) : null}
      {data?.brief ? (<><p className="ov">The brief, as Bao wrote it</p><pre className="code-well meeting-text" data-meeting-brief>{data.brief}</pre></>) : null}
      {row.options.length > 0 ? (
        <>
          <p className="ov">Options</p>
          <ul className="library-list">
            {row.options.map((o) => (
              <li key={o.key} className="meeting-option">
                <span className="small"><strong>{o.key}</strong> {o.title}{o.recommended ? <span className="muted"> · Bao recommends this</span> : null}</span>
                {row.canDecide ? <button type="button" className="btn btn-outline run-btn" title={off ?? undefined} disabled={!!off || busy} aria-label={`Choose option ${o.key}: ${o.title}`} onClick={() => meetings.steer(row.id, "decide", { option: o.key })}>Choose {o.key}</button> : null}
              </li>
            ))}
          </ul>
          {row.canDecide ? <p className="small muted">Choosing writes a ticket for the work and marks it as waiting for your approval. Nothing is built yet.</p> : null}
        </>
      ) : null}
      {row.decisions.length > 0 ? (
        <>
          <p className="ov">Your choices</p>
          <ul className="library-list">
            {row.decisions.map((d, i) => <li key={i} className="small">Option {d.option}, {d.title}. Proposed work: <span className="code-small">{d.ticket}</span>, waiting for your approval on the board.</li>)}
          </ul>
        </>
      ) : null}
      {data?.takes?.length > 0 ? (
        <>
          <p className="ov">Takes</p>
          {data.takes.map((t) => (
            <details key={`${t.role}-${t.n ?? 1}`} className="meeting-take" data-take={t.role} open={t.role === openRole || undefined}>
              <summary className="small"><span className="library-name">{t.role}</span>{t.n > 1 ? ` (take ${t.n})` : ""}</summary>
              <pre className="code-well meeting-text">{t.text}</pre>
            </details>
          ))}
        </>
      ) : null}
      {data?.thread?.length > 0 ? (
        <>
          <p className="ov">Follow-ups</p>
          <ul className="library-list">
            {data.thread.map((e, i) => <li key={i} className="small meeting-quote"><strong>{e.from === "user" ? "You" : "Bao"}:</strong> {e.text}</li>)}
          </ul>
        </>
      ) : null}
      {row.canAsk ? (
        <div className="meeting-ask">
          <label className="note-label" htmlFor={`ask-${row.id}`}>Ask a follow-up</label>
          <textarea id={`ask-${row.id}`} className="note-field" rows={2} maxLength={2000} value={text} disabled={!!off || busy} placeholder="Bao answers from the saved takes and the brief" onChange={(e) => setText(e.target.value)} />
          <div className="run-controls">
            <label className="small muted run-label" htmlFor={`reask-${row.id}`}>Ask again first</label>
            <select id={`reask-${row.id}`} className="run-select" value={reask} disabled={!!off || busy} onChange={(e) => setReask(e.target.value)}>
              <option value="">nobody</option>
              {row.roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="button" className="btn btn-outline run-btn" title={off ?? undefined} disabled={!!off || busy || !text.trim()} aria-busy={busy || undefined} onClick={ask}>Ask</button>
          </div>
          <p className="small muted">{reask ? `2 runs: ${reask} gives a new take, then Bao answers.` : "1 run: Bao answers."}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * team-and-den-ux/04: one meeting in the side sheet. The sheet's × only hides it (the meeting keeps running); Leave meeting
 * stops following it (it runs on to its brief, and its row offers Rejoin); End meeting… stops it after an inline confirm.
 */
export function MeetingSheet({ row, client, steer, meetings, openRole = null, onLeave }) {
  const off = steer.demo ? "Demo mode: actions are off" : steer.state === "none" ? "Not signed in to steer" : null;
  return (
    <>
      <p className="small" aria-live="polite">{row.line}</p>
      <Detail row={row} client={client} steer={steer} meetings={meetings} openRole={openRole} />
      {meetings.results[row.id]?.error ? <p className="small gate-error" role="alert">{meetings.results[row.id].error}</p> : null}
      <div className="run-controls den-sheet-actions">
        <button type="button" className="btn btn-outline run-btn" onClick={onLeave}>Leave meeting</button>
        <EndMeeting row={row} meetings={meetings} off={off} />
      </div>
    </>
  );
}

export function MeetingsCard({ client, snapshot, open, onToggle, busy, steer, meetings, shown, onShow, shownRole = null, left = null }) {
  const rows = meetingRows(snapshot);
  const waiting = rows.filter((r) => r.state === "briefed" || r.state === "paused").length;
  const running = rows.filter((r) => r.state === "running").length;
  const off = steer.demo ? "Demo mode: actions are off" : steer.state === "none" ? "Not signed in to steer" : null;
  return (
    <Card id="meetings" overlay="meetings" label="Meetings" edge="line" open={open} onToggle={onToggle} title="Meetings" aside={<span className="card-summary">{running > 0 ? `${running} running` : waiting > 0 ? `${waiting} waiting on you` : "none running"}</span>} busy={busy}>
      {rows.length > 0 ? (
        <ul className="queue-rows meeting-rows">
          {rows.map((r) => {
            const isOpen = shown === r.id;
            const acting = meetings.inflight.has(r.id);
            return (
              <li key={r.id} className="queue-row library-row" data-meeting={r.state}>
                <span className="queue-title">{r.title}</span>
                <span className="code-small muted">{r.ref}</span>
                <p className="small" aria-live="polite">{r.line}</p>
                {r.next ? <p className="small muted">{r.next}</p> : null}
                <ul className="library-list">
                  {r.seats.map((s) => <li key={s.role} className="small"><span aria-hidden="true">{SEAT_MARK[s.status]}</span> <span className="library-name">{s.role}</span> {s.line}</li>)}
                  <li className="small"><span aria-hidden="true">{r.hasBrief ? "●" : "○"}</span> <span className="library-name">Bao</span> chairs: {r.chair}</li>
                </ul>
                <div className="run-controls">
                  {/* team-and-den-ux/04: the meeting opens in the side sheet; one you left offers Rejoin. */}
                  <button type="button" className="btn btn-outline run-btn" aria-pressed={isOpen} onClick={(e) => onShow(r.id, e.currentTarget)}>{left?.has(r.id) ? "Rejoin" : r.hasBrief ? "Open the brief" : "Open"}</button>
                  {r.canStop ? <button type="button" className="btn btn-outline run-btn" title={off ?? undefined} disabled={!!off || acting} aria-label={`Pause the meeting ${r.title}`} onClick={() => meetings.steer(r.id, "stop")}>Pause</button> : null}
                  {r.canResume ? <button type="button" className="btn btn-solid run-btn" title={off ?? undefined} disabled={!!off || acting} onClick={() => meetings.steer(r.id, "resume")}>Resume</button> : null}
                  <EndMeeting row={r} meetings={meetings} off={off} />
                </div>
                {meetings.results[r.id]?.error ? <p className="small gate-error" role="alert">{meetings.results[r.id].error}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="small muted">No meeting yet.</p>}
      <Setup snapshot={snapshot} steer={steer} meetings={meetings} />
    </Card>
  );
}
