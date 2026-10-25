import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from './Card.jsx';
import { SPECIALISTS, SEATS_MAX, meetingRows, toggleRole } from './meeting-model.mjs';
import { ROLE_PORTRAITS } from '../shell/role-portraits.mjs';
import { AgentMarkdown } from './agent-markdown.mjs';

const money = n => `$${Number(n ?? 0).toFixed(2)}`;
const person = name => ({ bao: 'Bao', jiao: 'Jiao', 'chief-of-staff': 'Moderator', user: 'You' }[name] ?? name);
const stateName = state => ({ 'waiting-decision': 'Waiting on your decision', 'waiting-budget': 'Budget approval needed', pausing: 'Pausing…', paused: 'Paused', running: 'In discussion', 'ready-for-review': 'Ready for review', ended: 'Ended' }[state] ?? state);
const portrait = (role, moderator) => ROLE_PORTRAITS[`${moderator === 'jiao' ? 'codex:' : ''}${['bao', 'jiao', 'chief-of-staff'].includes(role) ? 'orchestrator' : role}`];
const blocked = steer => steer.demo || steer.state === 'none';
function Face({ role, moderator }) { return <img className="meeting-face" src={portrait(role, moderator)} alt="" />; }

export function useMeetings(client) {
  const pending = useRef(new Set());
  const [inflight, setInflight] = useState(new Set());
  const [results, setResults] = useState({});
  const call = useCallback(async (key, fn) => {
    if (pending.current.has(key)) return false;
    pending.current.add(key); setInflight(new Set(pending.current));
    setResults(r => ({ ...r, [key]: null }));
    try { return await fn() ?? true; }
    catch (e) { setResults(r => ({ ...r, [key]: { error: e?.reason ?? e?.message ?? 'The bridge refused the request.' } })); return false; }
    finally { pending.current.delete(key); setInflight(new Set(pending.current)); }
  }, []);
  const start = useCallback(body => call('new', () => client.startMeeting(body)), [call, client]);
  const steer = useCallback((id, action, body) => call(id, () => client.steerMeeting(id, action, body)), [call, client]);
  const end = useCallback(id => steer(id, 'close'), [steer]);
  return useMemo(() => ({ inflight, results, start, steer, end }), [inflight, results, start, steer, end]);
}

function Setup({ client, snapshot, steer, meetings, initial = {}, onStarted }) {
  const [topic, setTopic] = useState(initial.topic ?? '');
  const [roles, setRoles] = useState(initial.roles ?? []);
  const [ref, setRef] = useState(initial.ref ?? '');
  const [project, setProject] = useState(initial.project ?? 'den');
  const [moderator, setModerator] = useState(initial.moderator ?? '');
  const [depth, setDepth] = useState(initial.depth ?? 'quick');
  const [budget, setBudget] = useState(initial.budget ?? 2);
  const [projects, setProjects] = useState([{ slug: 'den' }]);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestId, setSuggestId] = useState(null);
  const [suggestState, setSuggestState] = useState(null);
  useEffect(() => { client.getProjects?.().then(body => setProjects(body.projects ?? body)).catch(() => {}); }, [client]);
  useEffect(() => {
    if (!suggestId) return;
    let active = true;
    const load = async () => { const data = await client.getMeeting(suggestId).catch(() => null); if (!active || !data) return; setSuggestState(data.meeting.state); if (data.meeting.suggestions?.length) { setSuggestions(data.meeting.suggestions); setRoles(data.meeting.suggestions.map(s => s.role)); setSuggestId(null); } };
    load(); const timer = setInterval(load, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [client, suggestId]);
  const busy = meetings.inflight.has('new');
  const disabled = blocked(steer) || busy;
  const range = (roles.length + 1) * (depth === 'dig-in' ? 0.9 : 0.4);
  const start = async (suggestOnly = false) => {
    const result = await meetings.start({ topic, roles: suggestOnly ? ['architect'] : roles, ...(ref.trim() ? { ref: ref.trim() } : {}), project, ...(moderator ? { moderator } : {}), depth, budget: Number(budget), continuedFrom: initial.continuedFrom, suggestOnly });
    if (result?.meeting) { if (suggestOnly) { setSuggestId(result.meeting.id); setSuggestState(result.meeting.state); } else onStarted?.(result.meeting.id); }
  };
  return <section className="meeting-setup" aria-label="Start a meeting">
    <p className="ov">{initial.continuedFrom ? 'Continue in a new meeting' : 'Start a meeting'}</p>
    <div className="meeting-setup-grid">
      <label>Project<select className="run-select" value={project} disabled={disabled} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p.slug} value={p.slug}>{p.name ?? p.slug}</option>)}</select></label>
      <label>Task (optional)<input className="note-field" placeholder="feature/08-task, or standalone" value={ref} disabled={disabled} onChange={e => setRef(e.target.value)} /></label>
      <label>Moderator<select className="run-select" value={moderator} disabled={disabled} onChange={e => setModerator(e.target.value)}><option value="">Task owner · Bao or Jiao</option><option value="bao">Bao · Claude</option><option value="jiao">Jiao · Codex</option></select></label>
    </div>
    <label className="note-label" htmlFor="meeting-topic">What would you like to think through?</label>
    <textarea id="meeting-topic" className="note-field" rows={3} maxLength={2000} value={topic} disabled={disabled} onChange={e => setTopic(e.target.value)} placeholder="Describe the topic and what matters to you…" />
    <fieldset className="meeting-role-grid" disabled={disabled}><legend>Specialists · {roles.length} of {SEATS_MAX}</legend>{SPECIALISTS.map(role => <label className="meeting-role-card glass" key={role}><input type="checkbox" checked={roles.includes(role)} disabled={!roles.includes(role) && roles.length >= SEATS_MAX} onChange={() => setRoles(r => toggleRole(r, role))} /><Face role={role} moderator={moderator} /><span>{role}<small>{suggestions.find(s => s.role === role)?.reason ?? 'Select to bring this perspective'}</small></span></label>)}</fieldset>
    <button type="button" disabled={disabled || !topic.trim() || !!suggestId} onClick={() => start(true)}>Suggest who · estimated {money(depth === 'dig-in' ? 0.9 : 0.4)}</button>
    {suggestState ? <p className="small">Suggestion consultation: {stateName(suggestState)}. This separate run counts toward its approved budget.{suggestId ? <button onClick={() => onStarted?.(suggestId)}>Open suggestion record</button> : null}</p> : null}
    <div className="meeting-setup-grid">
      <label>Depth<select className="run-select" value={depth} disabled={disabled} onChange={e => setDepth(e.target.value)}><option value="quick">Quick takes</option><option value="dig-in">Dig in</option></select></label>
      <label>Approved budget ($)<input className="note-field" type="number" min="0" step="0.25" value={budget} disabled={disabled} onChange={e => setBudget(e.target.value)} /></label>
    </div>
    <p className="small muted">{depth === 'quick' ? 'Concise independent views and focused follow-ups; code reading when needed.' : 'Investigate relevant code and docs, with evidence in deeper discussion.'} Specialists start at Medium effort.</p>
    <p className="small">Estimated {money(range / 5)}–{money(range)} for opening takes and one moderation pass. Further discussion adds work. Estimates are planning allowances, not exact billing limits.</p>
    <button type="button" className="btn-solid" disabled={disabled || !topic.trim() || !roles.length || budget === '' || Number(budget) < 0} onClick={() => start()}>Approve setup & start meeting ↗</button>
    {meetings.results.new?.error ? <p role="alert">{meetings.results.new.error}</p> : null}
  </section>;
}

function FollowUps({ m, meetings, disabled }) {
  const [drafts, setDrafts] = useState(() => m.proposals.map(p => ({ title: p.title, text: '', selected: false, includeRecord: true })));
  const [preview, setPreview] = useState(null);
  const [published, setPublished] = useState(null);
  const change = (i, patch) => { setDrafts(rows => rows.map((r, n) => n === i ? { ...r, ...patch } : r)); setPreview(null); };
  return <section className="meeting-followups"><h3>Proposed follow-ups</h3><p className="small muted">Select and edit public ticket text. Private notes are never copied automatically. Creating tickets starts no execution.</p>
    {m.proposals.map((p, i) => <div className="glass meeting-proposal" key={p.id}><label><input type="checkbox" checked={drafts[i]?.selected ?? false} onChange={e => change(i, { selected: e.target.checked })} /> Create a ticket</label><p className="small">Proposal: {p.title} · <a href={`#${p.sourceId}`}>source discussion</a></p><label>Public title<input className="note-field" value={drafts[i]?.title ?? ''} onChange={e => change(i, { title: e.target.value })} /></label><label>Exact public text<textarea className="note-field" rows={3} value={drafts[i]?.text ?? ''} onChange={e => change(i, { text: e.target.value })} placeholder="Write the ticket text you want to publish" /></label><label><input type="checkbox" checked={drafts[i]?.includeRecord ?? true} onChange={e => change(i, { includeRecord: e.target.checked })} /> Include the private record link (readable only with den access)</label></div>)}
    {!m.proposals.length ? <p className="small">No proposed tickets.</p> : <button disabled={disabled || !drafts.some(d => d.selected && d.text.trim())} onClick={async () => { const result = await meetings.steer(m.id, 'preview', { tickets: drafts.filter(d => d.selected).map(({ selected, ...d }) => d) }); if (result) setPreview(result); }}>Preview exact public tickets</button>}
    {preview?.tickets ? <div className="glass meeting-public-preview"><h3>Public preview · {m.project}</h3>{preview.tickets.map((p, i) => <article key={i}><h4>{p.title}</h4><pre>{p.text}</pre></article>)}<button className="btn-solid" disabled={disabled || !!published} onClick={async () => { const result = await meetings.steer(m.id, 'publish', { previewId: preview.previewId, approved: true }); if (result) setPublished(result); }}>Approve & create selected tickets</button></div> : null}
    {published ? <p role="status">Created {published.tickets?.length ?? 0} tickets awaiting approval. No execution started.</p> : null}
  </section>;
}

export function MeetingSheet({ row, client, steer, meetings, openRole = null, onContinue }) {
  const [data, setData] = useState(null), [error, setError] = useState(null);
  const [text, setText] = useState(''), [respond, setRespond] = useState(null), [to, setTo] = useState('');
  const [tab, setTab] = useState('conversation'), [custom, setCustom] = useState('');
  const [endConfirm, setEndConfirm] = useState(false), [budget, setBudget] = useState('');
  const [continuation, setContinuation] = useState(null), [record, setRecord] = useState(false);
  useEffect(() => { let active = true; client.getMeeting(row.id).then(body => { if (active) { setData(body); setError(null); } }, e => { if (active) setError(e.reason ?? 'Could not read the private record'); }); return () => { active = false; }; }, [client, row.id, row.stamp]);
  useEffect(() => { if (openRole && data) document.querySelector(`[data-take="${CSS.escape(openRole)}"]`)?.scrollIntoView({ block: 'nearest' }); }, [openRole, data]);
  const m = data?.meeting;
  if (!m) return <p role={error ? 'alert' : 'status'}>{error ?? 'Opening private meeting record…'}</p>;
  const disabled = blocked(steer) || meetings.inflight.has(m.id);
  const focusedQuestionId = m.focusedQuestionId ?? m.questions.findLast(q => q.options.length && !q.answer && !q.sentBack)?.id;
  const send = async () => { if (await meetings.steer(m.id, 'ask', { text, ...(respond ? { sourceId: respond, reask: to } : {}) })) { setText(''); setRespond(null); setTo(''); } };
  const sources = (ids, sourceMeetingId = null) => <span className="meeting-sources">{ids.map((id, i) => <a key={id} href={sourceMeetingId ? `/?meeting=${sourceMeetingId}#${id}` : `#${id}`}>Source {i + 1} ↗ </a>)}</span>;
  return <div className="meeting-workspace" data-state={m.state}>
    <h2 className="meeting-private-title">{m.title}</h2>
    <div className="meeting-context"><span><strong>{person(m.moderator)}</strong> moderating · {m.depth === 'dig-in' ? 'Dig in' : 'Quick takes'} · Round {m.round}</span><span>{m.project}{m.ref ? ` / ${m.ref}` : ' / Standalone'}</span><div className="meeting-participant-faces">{m.seats.filter(s => s.active !== false).map(s => <Face key={s.role} role={s.role} moderator={m.moderator} />)}</div></div>
    <div className="meeting-status" role="status"><strong>{stateName(m.state)}</strong><span>Actual reported {money(m.spent)}{m.estimatedSpent > 0 ? ` + est. ${money(m.estimatedSpent)} (billing unavailable)` : ''}</span><span>{money(m.budget)} budget · {m.live ? `1 running · est. ${money(m.live.estimate)}` : '0 running'}</span>{m.state === 'paused' || m.state === 'ready-for-review' ? <button disabled={disabled} onClick={() => meetings.steer(m.id, 'resume')}>{m.state === 'paused' ? 'Resume' : 'Discuss more'}</button> : m.state === 'running' ? <button disabled={disabled} onClick={() => meetings.steer(m.id, 'stop')}>Ⅱ Pause</button> : null}</div>
    {m.state === 'waiting-budget' ? <div className="glass meeting-budget"><strong>Approve before more work starts</strong><p>Next: {person(m.budgetRequest?.role)} · {m.budgetRequest?.effort} · estimated {money(m.budgetRequest?.estimate)}. Remaining {money(m.budgetRequest?.remaining)}.</p><label>New total budget ($)<input type="number" min={m.budget} step="0.25" value={budget} onChange={e => setBudget(e.target.value)} /></label><button disabled={disabled || Number(budget) <= m.budget} onClick={() => meetings.steer(m.id, 'budget', { budget: Number(budget) })}>Approve budget & continue</button></div> : null}
    <p className="meeting-state-note">{m.events.findLast(e => e.kind === 'status')?.text}</p>
    <nav className="meeting-tabs" aria-label="Meeting areas"><button aria-pressed={tab === 'conversation'} onClick={() => setTab('conversation')}>Conversation</button><button aria-pressed={tab === 'decisions'} onClick={() => setTab('decisions')}>Questions & decisions</button></nav>
    <div className={`meeting-columns meeting-tab-${tab}`}>
      <section className="meeting-conversation" aria-label="Conversation"><div className="meeting-section-title"><h3>Conversation</h3><small>{m.seats.filter(s => s.active !== false).length + 1} participants · {data.events.filter(e => e.kind === 'message').length} contributions</small></div>
        <div className="meeting-messages">{data.events.map(e => ['message', 'redirect', 'decision-answer', 'failure', 'decline'].includes(e.kind) ? <article id={e.id} key={e.id} data-take={e.actor} className={`meeting-message ${e.actor === 'user' ? 'meeting-user' : ''}`}><Face role={e.actor === 'user' ? m.moderator : e.actor} moderator={m.moderator} /><div className="meeting-message-content"><header><strong>{person(e.actor)}</strong><small>Round {e.round} · <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></small></header><div className="glass meeting-bubble">{e.sourceId ? sources([e.sourceId]) : null}<p>{e.partial ? <strong>Partial response · </strong> : null}{e.kind === 'message' ? (/^Claim:\s*(.*)/m.exec(e.text)?.[1] ?? (e.part === 'chair' ? 'Moderator contribution · expand to read the plan and evidence.' : e.text.split('\n')[0])) : e.text}</p>{e.appliesNext && !data.events.some(applied => applied.kind === 'redirect-applied' && applied.sourceId === e.id) ? <strong className="meeting-applies">Applies next · current responses finish first</strong> : null}</div>{e.kind === 'message' ? <><div className="meeting-message-actions"><details><summary>Explanation, sources & tools</summary><pre>{e.text}</pre><p>Confidence: {/Confidence:\s*(.+)/i.exec(e.text)?.[1] ?? 'unavailable from this contribution'}</p><p>Run: {e.runId} · {e.cost === null ? `estimated ${money(e.estimate)}; actual cost unavailable` : `actual ${money(e.cost)}`}</p>{e.tools?.length ? <ul>{e.tools.map((tool, i) => <li key={i}>{tool}</li>)}</ul> : <p>Tool activity unavailable in this record. No activity has been inferred.</p>}</details><button disabled={disabled || m.state === 'ended'} onClick={() => { setRespond(e.id); setTo(m.seats.find(s => s.active !== false && s.role !== e.actor)?.role ?? ''); }}>Ask someone to respond ↗</button></div></> : e.kind === 'failure' ? <button disabled={disabled || m.state === 'ended'} onClick={() => meetings.steer(m.id, 'retry', { role: ['bao', 'jiao'].includes(e.actor) ? 'chief-of-staff' : e.actor })}>Retry · budget applies</button> : null}</div></article> : e.kind === 'effort' || e.kind === 'participants' ? <p key={e.id} className="glass meeting-activity">{e.kind === 'effort' ? `${person(e.actor)} raised ${e.role} to High: ${e.text} · estimated ${money(e.estimate)}` : `Participants updated · ${e.text}`}</p> : null)}</div>
        {m.state !== 'ended' ? <div className="glass meeting-composer">{respond ? <div><label>Responding to <a href={`#${respond}`}>source message</a><select aria-label="Who should respond" value={to} onChange={e => setTo(e.target.value)}>{m.seats.filter(s => s.active !== false).map(s => <option key={s.role}>{s.role}</option>)}</select></label><button aria-label="Cancel linked response" onClick={() => setRespond(null)}>×</button></div> : null}<label className="visually-hidden" htmlFor="meeting-redirect">Jump in or redirect</label><textarea id="meeting-redirect" value={text} maxLength={2000} onChange={e => setText(e.target.value)} placeholder="Jump in, answer, or redirect the discussion…" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (text.trim() || (respond && to))) send(); }} /><footer><small>Current responses finish. Redirects apply before the next work.</small><button disabled={disabled || (!text.trim() && !respond) || (respond && !to)} onClick={send}>Send ↑</button></footer></div> : <p className="small">Ended · this record stays private permanently.</p>}
      </section>
      <aside className="meeting-decisions" aria-label="Questions and decisions"><h3>Questions & decisions</h3>
        {m.questions.map(q => <section className="glass meeting-decision" key={q.id}><p className="ov">{q.answer ? 'Answered' : q.sentBack ? 'Sent back for discussion' : 'Your call'}</p><h3>{q.question}</h3>{q.actor ? <p className="small">{person(q.actor)} asks you · Confidence: {q.confidence ?? 'unavailable'}</p> : null}{sources(q.sourceIds, q.sourceMeetingId)}{q.options.map(o => <div key={o.key} className={`glass meeting-choice ${o.key === q.recommended ? 'meeting-recommended' : ''}`}><strong>{o.title}</strong>{o.key === q.recommended ? <small>Recommended</small> : null}<p className="small">{o.tradeoff}</p>{!q.answer && !q.sentBack && q.id === focusedQuestionId && m.state === 'waiting-decision' ? <button disabled={disabled} onClick={() => meetings.steer(m.id, 'decide', { option: o.key, questionId: q.id })}>Choose {o.key}</button> : null}</div>)}{q.answer ? <p>Agreed: {q.answer.text} · <a href={`#${q.answer.eventId}`}>Your answer</a></p> : <><label>Write my answer<textarea className="note-field" value={custom} onChange={e => setCustom(e.target.value)} /></label><div className="meeting-decision-actions"><button disabled={disabled || (q.options.length > 0 && (q.id !== focusedQuestionId || m.state !== 'waiting-decision')) || m.state === 'ended' || !custom.trim()} onClick={() => meetings.steer(m.id, q.options.length ? 'decide' : 'ask', { text: custom, questionId: q.id })}>Save my answer ↗</button><button disabled={disabled || !q.options.length || q.id !== focusedQuestionId || m.state !== 'waiting-decision'} onClick={() => meetings.steer(m.id, 'decide', { sendBack: true, text: custom, questionId: q.id })}>Discuss more ↩</button></div><small>Answers enter the private record and resume within budget. No tickets are created.</small></>}</section>)}
        {!m.questions.length ? <p className="small muted">Open questions will appear here with recommendations, tradeoffs and source discussion.</p> : null}
        <section className="meeting-agreed"><h3>Agreed so far</h3>{m.decisions.map((d, i) => <p className="glass" key={i}>✓ {d.text} · <a href={d.sourceMeetingId ? `/?meeting=${d.sourceMeetingId}#${d.sourceId}` : `#${d.sourceId}`}>Source</a></p>)}</section>
        <details className="meeting-participants"><summary>Participants · edit for next work</summary>{SPECIALISTS.map(role => <label key={role}><input type="checkbox" checked={(m.pendingRoles ?? m.seats.filter(s => s.active !== false).map(s => s.role)).includes(role)} disabled={disabled || m.state === 'ended'} onChange={() => meetings.steer(m.id, 'participants', { roles: toggleRole(m.pendingRoles ?? m.seats.filter(s => s.active !== false).map(s => s.role), role) })} />{role}</label>)}{m.pendingRoles ? <p>Applies next · underway contributions finish and remain attributed.</p> : null}</details>
        {m.summary ? <section className="glass meeting-summary"><h3>Summary</h3><p>{m.summary}</p>{sources(data.events.filter(e => e.kind === 'summary').flatMap(e => e.sourceIds ?? (e.sourceId ? [e.sourceId] : [])))}</section> : null}
        {['ready-for-review', 'ended'].includes(m.state) ? <FollowUps key={m.id + m.proposals.map(p => p.id).join()} m={m} meetings={meetings} disabled={disabled} /> : null}
      </aside>
    </div>
    <footer className="meeting-footer"><button onClick={() => setRecord(!record)}>♧ Private meeting record</button><small>Permanent · discussion, decisions and notes linked to sources</small>{m.state !== 'ended' ? <button onClick={() => setEndConfirm(true)} disabled={disabled}>End meeting…</button> : <button disabled={disabled} onClick={async () => { const result = await meetings.steer(m.id, 'continue'); if (result) setContinuation(result.setup); }}>Continue this discussion ↗</button>}</footer>
    {endConfirm ? <div className="glass meeting-end-confirm" data-confirm role="group" aria-label="End meeting confirmation" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEndConfirm(false); } }}><p>End and save the closing summary, decisions and unanswered questions? No tickets are created.</p><button disabled={disabled} onClick={async () => { if (await meetings.end(m.id)) setEndConfirm(false); }}>End & save summary</button><button onClick={() => setEndConfirm(false)}>Keep meeting open</button></div> : null}
    {record ? <details open className="meeting-record"><summary>Private chronological record · {m.id}</summary>{data.events.map(e => <p id={['message', 'redirect', 'decision-answer', 'failure', 'decline'].includes(e.kind) ? undefined : e.id} key={e.id}><time>{e.at}</time> · {person(e.actor)} · {e.kind} · Round {e.round} · {e.text ?? e.state ?? e.role} {e.sourceId ? sources([e.sourceId]) : null}</p>)}</details> : null}
    {continuation ? <Setup client={client} snapshot={null} steer={steer} meetings={meetings} initial={continuation} onStarted={onContinue} /> : null}
    {meetings.results[m.id]?.error ? <p role="alert">{meetings.results[m.id].error}</p> : null}
  </div>;
}

export function MeetingsCard({ client, snapshot, open, onToggle, busy, steer, meetings, shown, onShow, left }) {
  const [query, setQuery] = useState(''), [project, setProject] = useState(''), [participant, setParticipant] = useState(''), [state, setState] = useState('');
  const [privateRows, setPrivateRows] = useState(null);
  const revision = snapshot?.meetings?.map(m => m.updatedAt).join();
  useEffect(() => { let active = true; client.getMeetings?.().then(body => { if (active) setPrivateRows(body.meetings); }).catch(() => {}); return () => { active = false; }; }, [client, revision, steer.state]);
  const source = privateRows ? { meetings: privateRows } : snapshot;
  const rows = meetingRows(source, Infinity).filter(r => (!project || r.project === project) && (!participant || r.roles.includes(participant)) && (!state || r.state === state) && `${r.title} ${r.ref ?? ''} ${r.summary}`.toLowerCase().includes(query.toLowerCase()));
  const [starting, setStarting] = useState(false);
  return <Card id="meetings" overlay="meetings" label="Meetings" edge="line" open={open} onToggle={onToggle} title="Meetings" busy={busy}>
    <p className="small muted">Think together. Permanent private discussion; opening a record never resumes it.</p>
    <div className="meeting-history-filters"><input className="note-field" aria-label="Search meetings by topic, summary or task" placeholder="Search meetings or tasks…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="Filter project" value={project} onChange={e => setProject(e.target.value)}><option value="">All projects</option>{[...new Set(meetingRows(source, Infinity).map(r => r.project))].map(p => <option key={p}>{p}</option>)}</select><select aria-label="Filter participant" value={participant} onChange={e => setParticipant(e.target.value)}><option value="">All participants</option>{SPECIALISTS.map(r => <option key={r}>{r}</option>)}</select><select aria-label="Filter status" value={state} onChange={e => setState(e.target.value)}><option value="">All statuses</option>{['running', 'waiting-decision', 'waiting-budget', 'pausing', 'paused', 'ready-for-review', 'ended'].map(s => <option value={s} key={s}>{stateName(s)}</option>)}</select></div>
    <div className="meeting-history">{rows.map(r => <article className="glass meeting-history-row" data-meeting={r.state} key={r.id}><strong>{r.title}</strong><p>{stateName(r.state)}{['waiting-decision', 'waiting-budget', 'paused'].includes(r.state) ? ' · Needs you' : ''}</p><small>{r.project} · {r.ref ?? 'Standalone'} · {r.roles.join(', ')}</small>{r.summary ? <details className="meeting-history-summary"><summary>Read summary</summary><AgentMarkdown text={r.summary} /></details> : null}<button aria-pressed={shown === r.id} onClick={e => onShow(r.id, e.currentTarget)}>{left?.has(r.id) ? 'Reopen record' : 'Open meeting'}</button></article>)}{!rows.length ? <p>No matching meetings.</p> : null}</div>
    <button className="btn-solid" onClick={() => setStarting(!starting)}>{starting ? 'Hide setup' : 'New meeting ↗'}</button>
    {starting ? <Setup client={client} snapshot={snapshot} steer={steer} meetings={meetings} onStarted={id => onShow(id)} /> : null}
  </Card>;
}
