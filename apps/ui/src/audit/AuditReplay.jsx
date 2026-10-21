// Hierarchy audit replay (design: the approved prototype, hierarchy-audit-replay.html). A read-only view of a run's
// event log: the tree as agents started, work going down and results coming up, and where time was spent working,
// waiting or unrecorded. Playing, seeking and inspecting only fold a prefix of the log (replay-core.mjs); nothing here
// calls the bridge, starts an agent or changes a run. All text renders as React text nodes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseRun, validateRun, replay, treeOf, duration, flowOf, rawOf, redactRun, summarize, LIMITS } from "./replay-core.mjs";
import { RUNS, runEntry } from "./runs/index.mjs";
import "./audit.css";

const SPEEDS = [0.5, 1, 2, 4];
const BASE_MS = 600; // one event per 600ms at 1x
const STATE_LABEL = {
  queued: "queued", started: "started", working: "working", waiting: "waiting", blocked: "blocked", awaiting: "awaiting approval or review",
  result: "result handed back", review: "reviewing", rework: "rework", accepted: "accepted", failed: "failed", cancelled: "cancelled", completed: "task complete",
};
// Kept across closing and reopening the sheet, so the replay comes back where it was left.
let remembered = { id: null, cursor: null };

const reducedMotion = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const utc = (ms) => (ms == null ? "—" : new Date(ms).toISOString().slice(11, 19) + " UTC");
const download = (name, text, type) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function Provenance({ run, imported }) {
  if (run.illustrative) return <p className="audit-banner audit-banner-sample" role="note"><strong>Illustrative sample.</strong> Invented events that show each state. Not a recorded run; models are illustrative tiers.</p>;
  if (imported) return <p className="audit-banner" role="note"><strong>Imported file, unverified.</strong> The viewer checks its structure, not where it came from.</p>;
  return <p className="audit-banner audit-banner-recorded" role="note"><strong>Recorded run</strong> ({run.source?.kind ?? "source not named"}). {run.source?.description}</p>;
}

function Times({ n }) {
  return (
    <dl className="audit-times">
      <div><dt>Working</dt><dd>{duration(n.workMs)}</dd></div>
      <div><dt>Waiting</dt><dd>{duration(n.waitMs)}</dd></div>
      <div><dt>Handed back</dt><dd>{duration(n.handoffMs)}</dd></div>
      <div><dt>Unknown</dt><dd>{duration(n.unknownMs)}</dd></div>
    </dl>
  );
}

function NodeCard({ n, current, selected, onSelect }) {
  const flow = current ? flowOf(current.kind) : null;
  const cls = ["audit-node", `audit-s-${n.status}`, `audit-l-${n.layer}`, selected ? "is-selected" : "", current ? "is-current" : "", flow ? `flow-${flow}` : ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} onClick={() => onSelect(n.agentId)} aria-pressed={selected} data-agent={n.agentId}>
      <span className="audit-node-top">
        <span className="audit-eyebrow">{n.layer}{n.attempt > 1 ? ` · attempt ${n.attempt}` : ""}</span>
        <span className={`audit-pill audit-pill-${n.status}`}>{STATE_LABEL[n.status] ?? n.status}</span>
      </span>
      <strong className="audit-node-name">{n.layer === "owner" ? n.name ?? "Owner (Bao or Jiao not recorded)" : n.name}</strong>
      <span className="audit-node-meta">{n.role} · {n.model ?? n.tier ?? "model not recorded"}</span>
      <span className="audit-node-task">{n.taskSummary}</span>
      {n.status === "blocked" || n.status === "waiting" || n.status === "awaiting" || n.status === "queued" ? <span className="audit-node-reason">{n.reason ?? "Reason not recorded"}</span> : null}
      <span className="audit-node-counts">{duration(n.workMs)} working · {duration(n.waitMs)} waiting{n.reworks ? ` · ${n.reworks} rework` : ""}{n.reviews ? ` · ${n.reviews} review${n.reviews > 1 ? "s" : ""}${n.bounces ? ` (${n.bounces} bounced)` : ""}` : ""}</span>
      {n.overLimit ? <span className="audit-node-limit">Over the {n.layer === "manager" ? LIMITS.managers : LIMITS.runnersPerManager}-{n.layer} limit</span> : null}
    </button>
  );
}

function Tree({ state, current, selected, onSelect }) {
  const tree = treeOf(state.nodes);
  const cur = (id) => (current && (current.agentId === id || current.relatedAgentId === id) ? current : null);
  if (!tree.owner) return <p className="audit-empty">No owner has started yet at this point in the log.</p>;
  return (
    <div className="audit-tree" role="group" aria-label="Agent tree at the cursor">
      <div className="audit-row audit-row-owner"><NodeCard n={tree.owner} current={cur(tree.owner.agentId)} selected={selected === tree.owner.agentId} onSelect={onSelect} /></div>
      {tree.managers.length ? (
        <div className="audit-row audit-row-managers">
          {tree.managers.map(({ node, runners }) => (
            <div key={node.agentId} className="audit-branch">
              <NodeCard n={node} current={cur(node.agentId)} selected={selected === node.agentId} onSelect={onSelect} />
              {runners.length ? <div className="audit-runners">{runners.map((r) => <NodeCard key={r.agentId} n={r} current={cur(r.agentId)} selected={selected === r.agentId} onSelect={onSelect} />)}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {tree.unplaced.length ? (
        <div className="audit-unplaced"><p className="audit-eyebrow">Not placed in the tree (parent not recorded as started)</p>
          <div className="audit-runners">{tree.unplaced.map((n) => <NodeCard key={n.agentId} n={n} current={cur(n.agentId)} selected={selected === n.agentId} onSelect={onSelect} />)}</div></div>
      ) : null}
    </div>
  );
}

function Timeline({ state, run }) {
  const first = state.task.firstTime, end = state.task.cursorTime;
  const full = Math.max(1, (Math.max(...run.events.map((e) => e.time)) - Math.min(...run.events.map((e) => e.time))) || 1);
  const runStart = Math.min(...run.events.map((e) => e.time));
  if (first == null) return null;
  return (
    <div className="audit-timeline" role="table" aria-label="Recorded time per agent">
      <div className="audit-legend" aria-hidden="true">
        <span className="k-work">Working or reviewing</span><span className="k-wait">Waiting, blocked or awaiting</span><span className="k-handoff">Handed back</span><span className="k-unknown">Unknown</span>
      </div>
      {state.nodes.map((n) => (
        <div key={n.agentId} className="audit-lane" role="row">
          <span className="audit-lane-name" role="rowheader">{n.layer === "owner" ? n.name ?? "Owner" : n.name}</span>
          <span className="audit-lane-bar" role="cell" aria-label={`${duration(n.workMs)} working, ${duration(n.waitMs)} waiting, ${duration(n.handoffMs)} handed back, ${duration(n.unknownMs)} unknown`}>
            {state.segments.filter((s) => s.agentId === n.agentId).map((s, i) => (
              <i key={i} className={`seg seg-${s.bucket}`} style={{ left: `${((s.from - runStart) / full) * 100}%`, width: `${Math.max(0.3, ((s.to - s.from) / full) * 100)}%` }} />
            ))}
          </span>
          <span className="audit-lane-wait" role="cell">{duration(n.waitMs)}</span>
        </div>
      ))}
      <p className="audit-note">Bars sit at their recorded timestamps and stop at the cursor ({utc(end)}). Parallel agents overlap, so agent times do not add up to the task span.</p>
    </div>
  );
}

function Evidence({ refs }) {
  if (!refs.length) return <p className="audit-missing">No evidence recorded for this event.</p>;
  return (
    <ul className="audit-evidence">
      {refs.map((r, i) => <li key={i}>{r.label}: {r.link ? <a href={r.ref} target="_blank" rel="noopener noreferrer">{r.ref}</a> : <code>{r.ref}</code>}</li>)}
    </ul>
  );
}

function Inspector({ run, state, agentId, event }) {
  const n = state.nodes.find((x) => x.agentId === agentId) ?? null;
  return (
    <aside className="audit-inspector" aria-label="Inspector">
      {n ? (
        <section>
          <p className="audit-eyebrow">Agent at the cursor</p>
          <h3>{n.layer === "owner" ? n.name ?? "Owner (Bao or Jiao not recorded)" : n.name}</h3>
          <dl className="audit-fields">
            <div><dt>Role</dt><dd>{n.role}</dd></div><div><dt>Layer</dt><dd>{n.layer}</dd></div>
            <div><dt>Runtime</dt><dd>{n.runtime ?? "not recorded"}</dd></div><div><dt>Model / tier</dt><dd>{n.model ?? "not recorded"}{n.tier ? ` / ${n.tier}` : ""}</dd></div>
            <div><dt>Parent</dt><dd>{n.parentId ?? "none (owner)"}</dd></div><div><dt>State</dt><dd>{STATE_LABEL[n.status] ?? n.status}</dd></div>
            <div><dt>Started</dt><dd>{utc(n.startedAt)} (event {n.firstSequence})</dd></div><div><dt>Attempt</dt><dd>{n.attempt}{n.restarts ? ` (${n.restarts} restart${n.restarts > 1 ? "s" : ""})` : ""}</dd></div>
            <div><dt>Commit</dt><dd>{n.commit ? <code>{n.commit}</code> : "not recorded"}</dd></div><div><dt>Pull request</dt><dd>{n.pr ? <a href={n.pr} target="_blank" rel="noopener noreferrer">{n.pr.replace("https://github.com/", "")}</a> : "not recorded"}</dd></div>
          </dl>
          {n.reason || n.blockedOn.length ? <p className="audit-reason"><strong>Recorded reason:</strong> {n.reason ?? "not recorded"}{n.blockedOn.length ? ` · waits on ${n.blockedOn.join(", ")}` : " · dependency not recorded"}</p> : null}
          <Times n={n} />
          <p className="audit-note">Events for this agent: {n.history.join(", ")}</p>
        </section>
      ) : <p className="audit-empty">Select an agent or an event.</p>}
      {event ? (
        <section>
          <p className="audit-eyebrow">Selected event</p>
          <h3>#{event.sequence} {event.kind}{event.verdict ? ` (${event.verdict})` : ""}</h3>
          <p className="audit-note">{event.timestamp} · {event.sourceRef ? `source ${event.sourceRef.log} line ${event.sourceRef.line}` : "no source line recorded"}{event.flags.length ? ` · ${event.flags.join(", ")}` : ""}</p>
          <Evidence refs={event.evidenceRefs} />
          <details className="audit-raw"><summary>Raw event</summary><pre>{JSON.stringify(rawOf(event), null, 2)}</pre></details>
        </section>
      ) : null}
      {run.illustrative ? <p className="audit-missing">Illustrative: no real test, commit or PR evidence exists for this run.</p> : null}
    </aside>
  );
}

export function AuditReplay({ initialId = null }) {
  const [entryId, setEntryId] = useState(() => initialId ?? remembered.id ?? "sample");
  const [load, setLoad] = useState({ status: "loading" });
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [agent, setAgent] = useState(null);
  const [eventSeq, setEventSeq] = useState(null);
  const [filter, setFilter] = useState("all");
  const [motion] = useState(() => !reducedMotion());
  const [importError, setImportError] = useState(null);
  const loadToken = useRef(0);
  const fileInput = useRef(null);

  const show = useCallback((parsed, id, imported = false) => {
    const end = parsed.run.events.length;
    const keep = remembered.id === id && remembered.cursor != null ? Math.min(remembered.cursor, end) : end;
    setLoad({ status: "ready", ...parsed, id, imported });
    setCursor(keep); setPlaying(false); setAgent(null); setEventSeq(null);
  }, []);

  // A run loads by name; a newer request (or closing the sheet) makes an older one's answer stale.
  useEffect(() => {
    if (entryId === "import") return undefined;
    const token = ++loadToken.current;
    const entry = runEntry(entryId);
    if (!entry) { setLoad({ status: "error", message: `No replay named "${entryId}".` }); return undefined; }
    setLoad((l) => (l.status === "ready" ? { ...l, refreshing: true } : { status: "loading" }));
    entry.load().then((value) => { if (token === loadToken.current) show(validateRun(structuredClone(value)), entryId); })
      .catch((err) => { if (token === loadToken.current) setLoad({ status: "error", message: err?.message ? `The replay did not load: ${err.message}` : "The replay did not load." }); });
    return () => { loadToken.current++; };
  }, [entryId, show]);

  const run = load.status === "ready" ? load.run : null;
  const state = useMemo(() => (run ? replay(run, cursor) : null), [run, cursor]);
  useEffect(() => { if (run) remembered = { id: load.id, cursor }; }, [run, load.id, cursor]);

  useEffect(() => {
    if (!playing || !run) return undefined;
    if (cursor >= run.events.length) { setPlaying(false); return undefined; }
    const t = setTimeout(() => setCursor((c) => Math.min(run.events.length, c + 1)), BASE_MS / speed);
    return () => clearTimeout(t);
  }, [playing, cursor, speed, run]);

  const onImport = async (file) => {
    setImportError(null);
    if (!file) return;
    try {
      if (file.size > LIMITS.bytes) throw new Error("The file is over 1 MiB.");
      const parsed = parseRun(await file.text());
      loadToken.current++;
      setEntryId("import");
      show(parsed, `import:${file.name}`, true);
    } catch (err) {
      setImportError(`${err?.message ?? "The file could not be read."} The previous replay is still shown.`);
    } finally { if (fileInput.current) fileInput.current.value = ""; }
  };

  const play = () => { if (!run) return; if (cursor >= run.events.length) setCursor(0); setPlaying((p) => !p); };
  const current = state && cursor > 0 ? run.events[cursor - 1] : null;
  const selectedEvent = run && eventSeq != null ? run.events.find((e) => e.sequence === eventSeq) ?? null : current;
  const events = run ? run.events.filter((e) => filter === "all" || (filter === "waits" ? ["waiting", "blocked", "awaiting", "queued", "failed", "cancelled", "rework"].includes(e.kind) || e.verdict === "bounce" : e.flags.length > 0)) : [];
  const reworks = state ? state.nodes.reduce((s, n) => s + n.reworks, 0) : 0;
  const bounces = state ? state.nodes.reduce((s, n) => s + n.bounces, 0) : 0;
  const warnings = load.issues?.filter((i) => i.level === "warn") ?? [];

  return (
    <div className={`audit${motion ? "" : " audit-still"}`} data-audit-state={load.status}>
      <div className="audit-toolbar">
        <label>Replay <select value={entryId === "import" ? "import" : entryId} onChange={(e) => { setImportError(null); setEntryId(e.target.value); }}>
          {RUNS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          {entryId === "import" ? <option value="import">Imported file</option> : null}
        </select></label>
        <button type="button" className="btn btn-outline" onClick={() => fileInput.current?.click()}>Import event file</button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => onImport(e.target.files?.[0])} />
      </div>
      {importError ? <p className="audit-error" role="alert">{importError}</p> : null}
      {load.status === "loading" ? <p className="audit-empty" role="status">Loading the replay…</p> : null}
      {load.status === "error" ? <p className="audit-error" role="alert">{load.message} <button type="button" className="btn btn-outline" onClick={() => { setEntryId("sample"); }}>Open the sample</button></p> : null}
      {run && state ? (
        <>
          <Provenance run={run} imported={load.imported} />
          {!state.atEnd ? <p className="audit-banner audit-banner-partial" role="status">Showing events 1-{cursor} of {run.events.length}; times stop at the cursor.</p> : null}
          {!run.complete ? <p className="audit-banner audit-banner-partial" role="status">Incomplete log: no final outcome is recorded, or events are missing. Unknown time is not counted as waiting.</p> : null}
          {load.issues.length ? (
            <details className="audit-issues" open={warnings.length > 0 && warnings.length <= 3}>
              <summary>{load.issues.length} note{load.issues.length > 1 ? "s" : ""} on this log ({warnings.length} warning{warnings.length === 1 ? "" : "s"})</summary>
              <ul>{load.issues.map((i, k) => <li key={k} className={`audit-issue-${i.level}`}>{i.message}</li>)}</ul>
            </details>
          ) : null}

          <div className="audit-tiles">
            <div><span>Task span</span><strong>{duration(state.task.spanMs)}</strong><small>first event to cursor</small></div>
            <div><span>Someone working</span><strong>{duration(state.task.workingMs)}</strong><small>at least one agent working or reviewing</small></div>
            <div className="tile-wait"><span>Waiting, nobody working</span><strong>{duration(state.task.waitingMs)}</strong><small>recorded waits only</small></div>
            <div className="tile-unknown"><span>Neither recorded</span><strong>{duration(state.task.unrecordedMs)}</strong><small>handoff gaps and unknown states</small></div>
            <div><span>Rework / bounced reviews</span><strong>{reworks} / {bounces}</strong><small>explicit events only</small></div>
          </div>

          <div className="audit-controls" role="group" aria-label="Playback">
            <button type="button" className="btn btn-outline" onClick={() => { setPlaying(false); setCursor(0); }} aria-label="Back to the start">⟲</button>
            <button type="button" className="btn btn-outline" onClick={() => { setPlaying(false); setCursor((c) => Math.max(0, c - 1)); }} aria-label="Previous event">‹</button>
            <button type="button" className="btn btn-primary audit-play" onClick={play} aria-pressed={playing}>{playing ? "Pause" : cursor >= run.events.length ? "Replay" : "Play"}</button>
            <button type="button" className="btn btn-outline" onClick={() => { setPlaying(false); setCursor((c) => Math.min(run.events.length, c + 1)); }} aria-label="Next event">›</button>
            <label>Speed <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}</select></label>
            <button type="button" className="btn btn-outline" onClick={() => { setPlaying(false); setCursor(run.events.length); }}>Static view (end)</button>
            <span className="audit-cursor">{current ? `${current.timestamp.slice(11, 19)} UTC · ` : ""}event {cursor}/{run.events.length}</span>
            <input className="audit-seek" type="range" min="0" max={run.events.length} value={cursor} aria-label="Seek to event" onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} />
          </div>
          {current ? <p className="audit-now" aria-live="polite">#{current.sequence} {current.name ?? "Owner"}: {STATE_LABEL[current.kind] ?? current.kind}{current.relatedAgentId ? ` → ${current.relatedAgentId}` : ""}{flowOf(current.kind) === "down" ? " (work going down)" : flowOf(current.kind) === "up" ? " (coming back up)" : ""}{current.flags.includes("skipped") ? " · not applied, see notes" : ""}</p> : null}

          <div className="audit-main">
            <div className="audit-stage">
              <Tree state={state} current={current} selected={agent} onSelect={(id) => { setAgent(id); setEventSeq(null); }} />
              <Timeline state={state} run={run} />
            </div>
            <Inspector run={run} state={state} agentId={agent ?? current?.agentId ?? null} event={selectedEvent} />
          </div>

          <section className="audit-log" aria-label="Event log">
            <div className="audit-log-head"><h3>Event log</h3>
              <label>Show <select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All events</option><option value="waits">Waits, failures and rework</option><option value="flags">Events with notes</option></select></label></div>
            <ol className="audit-events">
              {events.map((e) => (
                <li key={e.eventId} className={`${e.sequence > (current?.sequence ?? 0) ? "is-future" : ""}${eventSeq === e.sequence ? " is-selected" : ""}`}>
                  <button type="button" onClick={() => { setEventSeq(e.sequence); setAgent(e.agentId); }}>
                    <span className="audit-ev-seq">#{e.sequence} · {e.timestamp.slice(11, 19)}</span>
                    <span className="audit-ev-who">{e.name ?? "Owner"}</span>
                    <span className="audit-ev-what">{e.taskSummary}</span>
                    <span className={`audit-pill audit-pill-${e.kind}`}>{e.kind}{e.verdict ? `: ${e.verdict}` : ""}</span>
                  </button>
                  <button type="button" className="audit-ev-go" onClick={() => { setPlaying(false); setCursor(run.events.indexOf(e) + 1); setEventSeq(e.sequence); }} aria-label={`Seek to event ${e.sequence}`}>Go</button>
                </li>
              ))}
            </ol>
          </section>

          <details className="audit-how">
            <summary>How the times are derived</summary>
            <p>Only recorded state events set an agent's state; the time until that agent's next state event (or the cursor) is counted under it. Working, reviewing and rework count as working; waiting, blocked, queued and awaiting count as waiting; a result handed back but not yet accepted is its own bucket. Started, and any interval closed by an event after missing events or a backwards timestamp, is unknown. Nothing is inferred from a quiet agent, no clock is read, and nothing is counted after the last event.</p>
            <p>Duplicates are dropped and counted once; a restart needs a new attempt number, so work is never counted twice. Task times: "someone working" is the union of all working intervals; "waiting, nobody working" is recorded waiting outside those; the rest is "neither recorded". No critical path is claimed.</p>
          </details>

          <div className="audit-export">
            <button type="button" className="btn btn-outline" onClick={() => download(`hierarchy-replay-${cursor}.md`, summarize(run, cursor), "text/markdown")}>Download summary</button>
            <button type="button" className="btn btn-outline" onClick={() => download(`hierarchy-replay-redacted-${cursor}.json`, JSON.stringify(redactRun(run, cursor), null, 1), "application/json")}>Download redacted JSON</button>
            <p className="audit-note">Both stop at the cursor and drop names, tasks, reasons, IDs, models, commits and evidence; timestamps and structure remain. Replay is a view of the log, not proof.</p>
          </div>
        </>
      ) : null}
    </div>
  );
}

