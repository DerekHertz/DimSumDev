import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { sourceKey, sameSource } from "../../../shared/transcript-source.mjs";
import { initialTranscriptState, transcriptKey, transcriptToggle, closeTranscript, DESK_THREAD } from "./transcript-panel.mjs";
import { AgentMarkdown } from "./agent-markdown.mjs";
import { threadEntries, threadView, footModel, stopModel, emptyPicks, pickOption, setOther, questionAnswers } from "./thread-model.mjs";

const DESK_HINT = "Ask Bao about the repo, the board or CI. Bao proposes work; you start it from the den.";

const STATES = { working: "Working", "needs-you": "Needs your answer", waiting_on_user: "Needs your answer", blocked: "Blocked", done: "Done", failed: "Failed", terminated: "Stopped" };
const HISTORY_PAGE = 100;
const NO_HISTORY = { entries: [], more: false, before: null, error: null, loading: false };
const GLYPHS = { done: "✓", failed: "✕" };
const BOTTOM_SLACK = 24;

const timeOf = (at) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

// Panel state lives in App so the nearby card's R button and the R key share one rule (transcript-panel.mjs).
// The panel is pinned to its agent: identity is kept from the card it opened from.
export function useTranscript({ card, exploring, onOpen, blocked, returnFocus }) {
  const [panel, setPanel] = useState(initialTranscriptState);
  const [identity, setIdentity] = useState(null);
  const latest = useRef({});
  latest.current = { panel, card, exploring, onOpen, blocked, returnFocus };
  const intercept = useRef(null); // the thread's own use for Esc (the stop confirm); true means Esc was taken

  const commit = useCallback((next) => {
    const { panel: previous, card: current } = latest.current;
    if (next === previous) return;
    if (next.agentId && !previous.agentId) {
      setIdentity({ name: current?.name || current?.role || next.agentId, role: current?.role ?? "", state: current?.state ?? "", runtime: current?.runtime, project: current?.project });
      latest.current.onOpen?.();
    }
    if (!next.agentId && previous.agentId) {
      const back = latest.current.returnFocus; // team-and-den-ux/04: the shell returns focus to what opened the conversation
      queueMicrotask(() => {
        if (back?.()) return;
        const free = document.querySelector(".den-cursor-free .proximity-card button[data-key=R]");
        (free ?? document.querySelector('main[aria-label="Den scene"]'))?.focus({ preventScroll: true });
      });
    }
    latest.current.panel = next;
    setPanel(next);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (latest.current.blocked?.current) return; // den-v1/06: the permission review owns the keys while it is open
      if (e.key !== "Escape" && e.target?.closest?.("input,select,textarea,[contenteditable]")) return;
      const { panel: current, card: nearby, exploring: walking } = latest.current;
      if (e.key === "Escape" && current.agentId && intercept.current?.()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const { state, handled } = transcriptKey(current, { key: e.key, card: nearby, mode: walking ? "walk" : "diorama" });
      if (!handled) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) commit(state);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [commit]);

  // team-and-den-ux/04 (spec section 5): leaving the den never closes a conversation; only its own close does.
  // A different nearby card clears an old notice.
  useEffect(() => { if (latest.current.panel.notice) commit({ ...latest.current.panel, notice: null }); }, [card?.id, commit]);

  return {
    panel,
    identity,
    toggle: useCallback((nearby) => commit(transcriptToggle(latest.current.panel, nearby)), [commit]),
    close: useCallback(() => commit(closeTranscript(latest.current.panel)), [commit]),
    // den-mvp outcome 2: open the thread of one run from a panel (no card nearby), and move an open thread to the
    // follow-up run that continues it. Both keep the panel open outside walk mode.
    openFor: useCallback((agentId, who, options) => {
      if (!agentId || latest.current.blocked?.current) return;
      latest.current.card = who ?? null;
      setIdentity({ name: who?.name || who?.role || agentId, role: who?.role ?? "", state: who?.state ?? "", runtime: who?.runtime, project: who?.project });
      commit({ agentId, notice: null, pinned: true, request: options ? { source: options.source, expandTool: options.expandTool === true } : null });
    }, [commit]),
    follow: useCallback((agentId) => {
      const current = latest.current.panel;
      if (!agentId || !current.agentId || agentId === current.agentId) return;
      latest.current.panel = { ...current, agentId };
      setPanel(latest.current.panel);
    }, []),
    intercept,
  };
}

function ToolRow({ row, onToggle }) {
  const id = `transcript-tool-${row.n}`;
  return <li className={`transcript-row transcript-tool transcript-status-${row.status}`}>
    <button type="button" className="transcript-tool-head" aria-expanded={row.expanded} aria-controls={id} onClick={() => onToggle(row.source ?? row.n)} title={row.toggleLabel}>
      <span className="transcript-chevron" aria-hidden="true" />
      <code className="transcript-tool-name">{row.name}</code>
      <span className="transcript-tool-summary">{row.summary}</span>
      <span className="transcript-tool-status">{row.statusLabel}</span>
    </button>
    {row.expanded ? <div id={id} className="transcript-tool-body">
      {row.inputText ? <><p className="transcript-detail-label">Input</p><pre className="transcript-well" aria-label="Input">{row.inputText}</pre></> : null}
      <p className="transcript-detail-label">Result</p>
      {row.result ? <>
        <pre className="transcript-well" aria-label="Result">{row.result.text}</pre>
        {row.result.truncatedBytes ? <p className="transcript-truncated">Truncated, {row.result.truncatedBytes} more bytes</p> : null}
      </> : <p className="transcript-truncated">{row.resultLabel}</p>}
    </div> : null}
  </li>;
}

function Chips({ chips }) {
  if (!chips?.length) return null;
  return <p className="thread-chips">{chips.map((c, i) => <span key={i} className={`thread-chip thread-chip-${c.state}`}>
    {GLYPHS[c.state] ? <span aria-hidden="true">{GLYPHS[c.state]} </span> : null}{c.text}
  </span>)}</p>;
}

// Every string a row shows (the agent's words, a reason, a note, a command) is untrusted and rendered as a text node.
// den-mvp/37: an agent's question, answered here. Each option is a button; "Other" takes the user's own words.
function QuestionRow({ row, who, client, disabled, ...locator }) {
  const [picks, setPicks] = useState(() => emptyPicks(row.questions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const answers = questionAnswers(row.questions, picks);
  const send = async (decision) => {
    setBusy(true);
    setError(null);
    try {
      await client.decide(row.approvalId, decision === "allow" ? { decision, answers } : { decision, note: "The user dismissed the question." });
    } catch (err) {
      setError(err?.reason ?? "The bridge did not answer.");
      setBusy(false);
    }
  };
  const off = disabled || busy || !row.answerable || !client;
  return <li {...locator} className="transcript-row transcript-permission transcript-asking transcript-question" role="group" aria-label={`${who} is asking you`}>
    <p className="transcript-waiting"><span className="transcript-glyph transcript-glyph-needs-you" aria-hidden="true" />{row.head}</p>
    {row.questions.map((q, qi) => <fieldset key={qi} className="question-set" disabled={off}>
      <legend>{q.header ? <span className="question-header">{q.header}</span> : null}{q.question}{q.multiSelect ? <span className="question-hint"> Pick any.</span> : null}</legend>
      <div className="question-options">
        {q.options.map((o) => {
          const on = picks[qi].labels.includes(o.label);
          return <button key={o.label} type="button" className="question-option" aria-pressed={on} onClick={() => setPicks(pickOption(row.questions, picks, qi, o.label))}>
            <span className="question-label">{o.label}</span>
            {o.description ? <span className="question-description">{o.description}</span> : null}
          </button>;
        })}
        <button type="button" className="question-option" aria-pressed={picks[qi].other !== null} onClick={() => setPicks(pickOption(row.questions, picks, qi, null))}>
          <span className="question-label">Other</span>
        </button>
        {picks[qi].other !== null ? <input type="text" className="question-other" aria-label={`Your answer to: ${q.question}`} maxLength={500} autoFocus
          value={picks[qi].other} onChange={(e) => setPicks(setOther(picks, qi, e.target.value))} /> : null}
      </div>
    </fieldset>)}
    {error ? <p className="approval-banner" role="alert">{error}</p> : null}
    <div className="transcript-answer">
      <button type="button" className="approval-deny" disabled={off} onClick={() => send("deny")}>Dismiss</button>
      <button type="button" className="approval-allow" disabled={off || !answers} onClick={() => send("allow")}>{busy ? "Sending" : "Send answer"}</button>
    </div>
  </li>;
}

function Row({ row, onToggle, onAnswer, who, client, demo }) {
  // Apply the locator to the existing list item without adding nested list markup.
  const content = RowContent({ row, onToggle, onAnswer, who, client, demo });
  return cloneElement(content, { "data-source": sourceKey(row.source) ?? undefined, "aria-current": row.focused ? "location" : undefined, tabIndex: row.source ? -1 : undefined });
}

function RowContent({ row, onToggle, onAnswer, who, client, demo }) {
  switch (row.kind) {
    case "question":
      return <QuestionRow row={row} who={who} client={client} disabled={demo} />;
    case "message":
      return <li className="transcript-row transcript-message thread-agent">
        <p className="transcript-speaker">{who} <time>{timeOf(row.at)}</time></p>
        <AgentMarkdown text={row.text} />
      </li>;
    case "you":
      return <li className="transcript-row thread-you">
        <p className="transcript-speaker">You <time>{timeOf(row.at)}</time></p>
        <p className="transcript-text thread-bubble thread-bubble-you">{row.text}</p>
        <Chips chips={row.chips} />
      </li>;
    case "answer":
      return <li className="transcript-row thread-you">
        <p className="thread-system">{row.asked}</p>
        <p className="transcript-speaker">You <time>{timeOf(row.at)}</time></p>
        <p className="transcript-text thread-bubble thread-bubble-you">{row.text}{row.note ? <> <q>{row.note}</q></> : null}</p>
        <Chips chips={row.chips} />
      </li>;
    case "tool":
      return ToolRow({ row, onToggle });
    case "ask":
      // Both buttons open the permission review, which shows the full input and sends the answer.
      return <li className="transcript-row transcript-permission transcript-asking" role="group" aria-label={`${who} is asking to ${row.verb}`}>
        <p className="transcript-waiting"><span className="transcript-glyph transcript-glyph-needs-you" aria-hidden="true" />{row.head}</p>
        <p className={`thread-reason${row.reasonFallback ? " thread-reason-none" : ""}`}>{row.reasonFallback ? row.reason : <q>{row.reason}</q>}</p>
        {row.intent ? <p className="thread-intent">Why this command: {row.intent}</p> : null}
        {row.command ? <details className="thread-details">
          <summary>Show the {row.detailLabel.toLowerCase()}</summary>
          <pre className="transcript-well"><code>{row.command}</code></pre>
        </details> : null}
        {row.answerable ? <>
          <div className="transcript-answer">
            <button type="button" className="approval-deny" data-answer="deny" aria-label={`Deny ${row.verb}`} onClick={() => onAnswer?.()}>Deny</button>
            <button type="button" className="approval-allow" data-answer="allow" aria-label={`Allow ${row.verb}`} onClick={() => onAnswer?.()}>Allow</button>
          </div>
          <p className="thread-hint">Opens the full request first</p>
        </> : null}
      </li>;
    case "asked":
      return <li className="transcript-row thread-system">{row.waiting ? <span className="transcript-waiting"><span className="transcript-glyph" aria-hidden="true" />Waiting on you · </span> : null}{row.label}</li>;
    case "run":
      return <li className="transcript-row thread-system thread-run">{row.label} <time>{timeOf(row.at)}</time></li>;
    case "ended":
      return <li className={`transcript-row transcript-ended thread-system transcript-ended-${row.state}`}>{row.label} <time>{timeOf(row.at)}</time></li>;
    default:
      return <li className="transcript-row transcript-unreadable">{row.label}{row.type ? ` (${row.type})` : ""}</li>;
  }
}

// The foot of the thread: one box, Send, and Stop with a one-step confirm. The box sends to the live run, or follows up
// a run that has ended (the bridge continues its session in a new run, and the thread moves to it).
function Foot({ tx, agent, role, client, connection, signedIn, demo, onAnnounce }) {
  const desk = tx.panel.agentId === DESK_THREAD;
  const foot = footModel({ agent, connection, signedIn, demo, desk });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [stop, setStop] = useState({ phase: "idle", error: null });
  const keepRef = useRef(null);
  const stopRef = useRef(null);
  const boxRef = useRef(null);
  const agentId = agent?.id ?? null;
  useEffect(() => { setStop({ phase: "idle", error: null }); setSendError(null); }, [agentId]);
  useEffect(() => { if (stop.phase === "confirm") keepRef.current?.focus({ preventScroll: true }); }, [stop.phase]);
  // Esc belongs to the confirm while it is up: it keeps the agent going and leaves the thread open.
  const cancel = useCallback(() => { setStop({ phase: "idle", error: null }); queueMicrotask(() => stopRef.current?.focus({ preventScroll: true })); }, []);
  tx.intercept.current = stop.phase === "confirm" ? () => { cancel(); return true; } : null;
  useEffect(() => () => { tx.intercept.current = null; }, [tx]);
  const view = stopModel({ ...stop, agent });
  useEffect(() => { if (view.announce) onAnnounce(view.announce); }, [view.announce, onAnnounce]);

  const send = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!foot.canSend || sending || !body || !client?.converse) return;
    setSending(true);
    setSendError(null);
    try {
      const sent = await client.converse(role, { text: body, runId: desk ? undefined : agentId });
      setText("");
      if (sent?.resumed && sent.agent?.id) tx.follow(sent.agent.id);
    } catch (err) {
      setSendError(`Couldn't send: ${err?.status || ""} ${err?.reason ?? ""}`.replace(/\s+/g, " ").trim());
    } finally {
      setSending(false);
      boxRef.current?.focus({ preventScroll: true });
    }
  };
  const doStop = async () => {
    if (!client?.stopAgent || !agentId) return;
    setStop({ phase: "sending", error: null });
    try {
      await client.stopAgent(agentId);
      setStop({ phase: "sent", error: null });
    } catch (err) {
      setStop({ phase: "failed", error: { status: err?.status ?? 0, reason: err?.reason ?? "" } });
    }
  };

  return <form className="thread-foot" onSubmit={send} aria-busy={view.busy || sending || undefined}>
    {view.confirm ? <div className="thread-confirm" role="group" aria-label="Stop this agent?" data-confirm>
      <p>Stop this agent?</p>
      <button type="button" className="thread-stop" onClick={doStop}>Stop</button>
      <button type="button" className="thread-keep" ref={keepRef} onClick={cancel}>Keep going</button>
    </div> : <div className="thread-compose">
      <input type="text" className="thread-box" ref={boxRef} value={text} maxLength={2048} placeholder={foot.placeholder} aria-label={foot.placeholder || "Message"}
        readOnly={foot.readOnly} disabled={foot.mode === "off" || foot.mode === "ended"} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="thread-send" disabled={!foot.canSend || sending || !text.trim()}>{sending ? "Sending…" : foot.sendLabel}</button>
      {foot.stopShown ? <button type="button" className="thread-stop" ref={stopRef} disabled={!foot.canStop || view.busy} title={foot.canStop ? undefined : foot.reason ?? undefined} onClick={() => setStop({ phase: "confirm", error: null })}>Stop agent</button> : null}
    </div>}
    {foot.reason ? <p className="thread-foot-note">{foot.reason}</p> : null}
    {view.chip ? <Chips chips={[view.chip]} /> : null}
    {sendError ? <p className="thread-alert" role="alert">{sendError}</p> : null}
    {view.alert ? <p className="thread-alert" role="alert">{view.alert}</p> : null}
  </form>;
}

export function TranscriptPanel({ tx, transcripts, agents, approvals, onAnswer, connection, client = null, signedIn = true, demo = false }) {
  const { panel, identity } = tx;
  const agentId = panel.agentId;
  const buffer = agentId ? transcripts?.[agentId] : undefined;
  const agent = agentId ? agents?.find((a) => a.id === agentId) ?? null : null;
  const role = agent?.role ?? identity?.role ?? "";
  const runtime = agent?.runtime ?? identity?.runtime;
  const project = agent?.project ?? identity?.project;
  const [expanded, setExpanded] = useState([]);
  const [atBottom, setAtBottom] = useState(true);
  const [seenThrough, setSeenThrough] = useState(0);
  const [history, setHistory] = useState(NO_HISTORY);
  const historyRef = useRef(history);
  historyRef.current = history;
  const historyScope = useRef(null);
  const historyGeneration = useRef(0);
  const earlierPending = useRef(false);
  const [announcement, setAnnouncement] = useState("");
  const [sourceState, setSourceState] = useState(null);
  const focusedRequest = useRef(null);
  const log = useRef(null);
  const bottomRef = useRef(true);
  const lastN = useRef(0);
  const announced = useRef(new Set());
  // Receipts change with time ("Still stopping…", "No reply yet"), so an open thread keeps its own one-second clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!agentId) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [agentId]);
  const list = threadEntries({ history: history.entries, buffer, agentId });
  const view = threadView(list, { expanded, atBottom, seenThrough, connection, approvals, agents, now });
  lastN.current = view.rows.at(-1)?.n ?? 0;

  // Reset before a synchronous live-source lookup can complete in the layout effects below.
  useLayoutEffect(() => { setExpanded([]); setSourceState(null); focusedRequest.current = null; setAtBottom(true); setSeenThrough(0); bottomRef.current = true; }, [agentId]);
  useEffect(() => { if (agentId) document.querySelector("#sheet-side-title")?.focus({ preventScroll: true }); }, [agentId]);

  // The role's earlier runs (den-mvp outcome 2): asked from the bridge when the thread opens or moves to a new run, a
  // page at a time. Demo mode and a page with no client read nothing.
  const canRead = !!agentId && !!role && !demo && typeof client?.getConversation === "function";
  useLayoutEffect(() => {
    const generation = ++historyGeneration.current;
    earlierPending.current = false;
    const scope = JSON.stringify([agentId, role, runtime, project]);
    const previous = historyScope.current === scope ? historyRef.current : NO_HISTORY;
    historyScope.current = scope;
    if (!canRead) { setHistory(NO_HISTORY); setSourceState(panel.request ? "unavailable" : null); return undefined; }
    let stale = false;
    const request = panel.request;
    const target = request?.source;
    const valid = !request || sourceKey(target) && target.role === role && target.runtime === runtime && target.project === project;
    setSourceState(request ? valid ? "loading" : "unavailable" : null);
    if (!valid) { setHistory(previous); return undefined; }
    setHistory({ ...previous, loading: true, error: null });
    (async () => {
      let entries = previous.entries, before = previous.before ?? undefined, more = previous.more;
      const cursors = new Set();
      if (before !== undefined) cursors.add(before);
      try {
        for (let reads = 0; reads < (request ? 3 : 1); reads += 1) {
          if (request && [...entries, ...(buffer?.entries ?? [])].some(e => sameSource(e.source, target))) break;
          if (previous !== NO_HISTORY && !previous.loading && !more) break;
          const page = await client.getConversation(role, { limit: HISTORY_PAGE, ...(before === undefined ? {} : { before }), ...(runtime ? { runtime } : {}), ...(project ? { project } : {}) });
          if (stale || generation !== historyGeneration.current) return;
          entries = [...page.entries, ...entries];
          more = page.more === true;
          const repeated = cursors.has(page.before);
          before = page.before;
          cursors.add(before);
          const found = [...entries, ...(buffer?.entries ?? [])].filter(e => sameSource(e.source, target));
          if (!request || found.length || !more || repeated) { if (repeated) more = false; break; }
        }
        if (!stale) {
          setHistory({ entries, more, before, error: null, loading: false });
          if (request) setSourceState("ready");
        }
      } catch (err) {
        if (!stale) {
          setHistory(h => ({ ...h, loading: false, error: err?.reason ?? "Could not load earlier messages." }));
          if (request) setSourceState("unavailable");
        }
      }
    })();
    return () => { stale = true; historyGeneration.current += 1; };
  }, [canRead, agentId, role, runtime, project, client, panel.request]);
  useLayoutEffect(() => {
    const request = panel.request;
    if (!request || sourceState !== "ready" || focusedRequest.current === request) return;
    const matches = list.entries.filter(e => sameSource(e.source, request.source));
    if (matches.length !== 1) { setSourceState("unavailable"); return; }
    const el = [...(log.current?.querySelectorAll("li[data-source]") ?? [])].find(el => el.dataset.source === sourceKey(request.source));
    if (!el) { setSourceState("unavailable"); return; }
    focusedRequest.current = request;
    bottomRef.current = false;
    setAtBottom(false);
    setSeenThrough(lastN.current);
    if (request.expandTool && matches[0].kind === "tool") setExpanded(open => [...open.filter(v => !sameSource(v, request.source)), request.source]);
    el.focus({ preventScroll: true });
    const scroller = log.current;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [sourceState, panel.request, list.entries]);
  const loadEarlier = () => {
    if (!canRead || history.loading || !history.more || earlierPending.current) return;
    const generation = historyGeneration.current;
    earlierPending.current = true;
    setHistory((h) => ({ ...h, loading: true }));
    client.getConversation(role, { before: history.before, limit: HISTORY_PAGE, ...(runtime ? { runtime } : {}), ...(project ? { project } : {}) }).then(
      (page) => { if (generation === historyGeneration.current) { earlierPending.current = false; setHistory((h) => ({ entries: [...page.entries, ...h.entries], more: page.more === true && page.before !== h.before, before: page.before, error: null, loading: false })); } },
      (err) => { if (generation === historyGeneration.current) { earlierPending.current = false; setHistory((h) => ({ ...h, loading: false, error: err?.reason ?? "Could not load earlier messages." })); } },
    );
  };

  // A new ask is announced once, in the polite region; the log itself stays quiet.
  const name = identity?.name ?? (role ? role[0].toUpperCase() + role.slice(1) : agentId);
  const asking = view.rows.findLast((row) => row.kind === "ask" && row.answerable);
  useEffect(() => {
    if (!asking || announced.current.has(asking.approvalId)) return;
    announced.current.add(asking.approvalId);
    setAnnouncement(`${name} is asking to ${asking.verb}`);
  }, [asking?.approvalId]);

  // New events keep arriving; only a reader already at the bottom follows them (appending never moves focus).
  useLayoutEffect(() => {
    const el = log.current;
    if (el && bottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lastN.current, agentId, expanded]);

  const onScroll = () => {
    const el = log.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    if (bottom !== bottomRef.current) {
      bottomRef.current = bottom;
      setAtBottom(bottom);
      if (!bottom) setSeenThrough(lastN.current);
    }
  };
  const jump = () => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
    bottomRef.current = true;
    setAtBottom(true);
    el?.focus({ preventScroll: true });
  };
  const toggleRow = (key) => setExpanded(open => {
    const same = v => typeof key === "object" ? sameSource(v, key) : v === key;
    return open.some(same) ? open.filter(v => !same(v)) : [...open, key];
  });

  const notice = panel.notice ? <p className="transcript-notice visually-hidden" role="status" aria-live="polite">{panel.notice}</p> : null;
  if (!agentId) return notice;
  const state = agent?.state ?? identity?.state ?? "";
  const ref = typeof agent?.ref === "string" ? agent.ref.slice(agent.ref.indexOf("/") + 1) : "";
  return <>
    {notice}
    <aside id="sheet-side" className="transcript-panel thread-panel" data-sheet="side" role="dialog" aria-modal="false" aria-label={`Conversation with ${name}`}>
      <header className="transcript-head">
        <div>
          <p className="transcript-overline">Conversation</p>
          <h2 id="sheet-side-title" tabIndex={-1}>{[name, ref].filter(Boolean).join(" · ")}</h2>
          <p className="transcript-meta"><code>{agentId}</code>{role && role !== name ? ` · ${role}` : ""}{runtime ? ` · ${runtime}` : ""}{project ? ` · ${project}` : ""}</p>
          <p className="transcript-state"><span className={`transcript-glyph transcript-glyph-${state}`} aria-hidden="true" />{STATES[state] ?? state}</p>
        </div>
        <button type="button" className="transcript-close" aria-label="Close conversation" onClick={tx.close}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" /></svg>
        </button>
      </header>
      {view.banner ? <p className="transcript-banner" role="status">{view.banner}</p> : null}
      {sourceState === "unavailable" ? <p className="transcript-banner" role="status">Source unavailable</p> : sourceState === "loading" ? <p className="transcript-banner" role="status">Loading source…</p> : null}
      <div className="thread-body">
      <div className="transcript-log" role="log" aria-live="off" aria-label={`Conversation with ${name}`} tabIndex={0} ref={log} onScroll={onScroll}>
        {history.more ? <p className="thread-earlier"><button type="button" className="transcript-jump-button" disabled={history.loading} onClick={loadEarlier}>{history.loading ? "Loading…" : "Show earlier"}</button></p> : null}
        {history.error ? <p className="transcript-dropped">Earlier messages could not be loaded: {history.error}</p> : null}
        {view.empty ? <p className="transcript-empty">{agentId === DESK_THREAD ? DESK_HINT : view.emptyText}</p> : <>
          {view.droppedNotice ? <p className="transcript-dropped">{view.droppedText}</p> : null}
          <ul className="transcript-list">{view.rows.map((row) => <Row key={sourceKey(row.source) ?? row.n} row={{ ...row, focused: sourceState === "ready" && sameSource(row.source, panel.request?.source) }} who={name} onToggle={toggleRow} onAnswer={() => onAnswer?.(agentId)} client={signedIn ? client : null} demo={demo} />)}</ul>
        </>}
      </div>
      <div className="transcript-jump" aria-live="polite">
        {view.jumpLabel ? <button type="button" className="transcript-jump-button" onClick={jump}>{view.jumpLabel}</button> : null}
      </div>
      </div>
      <Foot tx={tx} agent={agent} role={role} client={client} connection={connection} signedIn={signedIn} demo={demo} onAnnounce={setAnnouncement} />
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    </aside>
  </>;
}
