import { pendingLine, STATE_LABELS } from './proximity-card.mjs';

const LABELS = { Q: 'Deny', E: 'Allow', R: 'Transcript', T: 'Message' };
const NEXT = { Q: 'Opens the permission request', E: 'Opens the permission request', R: 'Opens the live transcript', T: 'Opens the message box' };

// den-v1/05: R opens the transcript when an agent is running. den-v1/06: E and Q open the permission review when an
// approval is pending (and not in demo mode). den-v1/07: T opens the message composer and the card shows the latest message's status line.
// den-v1 loop S1: on a resident the bridge can start (card.start), T is "Start task" and opens the same composer as a task box.
// den-v1 loop S4: a panda whose last agent has ended shows that run's outcome, its reply excerpt and the cost badge (card.last).
const START = { label: 'Start task', next: 'Opens the task box' };
const DEMO_REASON = 'Demo mode: actions are off';
// Overview (live den run, 2026-10-10): the same card for a panda the user clicked; `onClose` adds its Close button.
export function ProximityCard({ card, onTranscript, onAnswer, onMessage, onInspectTools, toolActivity, onClose = null, status = null, transcriptOpen = false, demo = false }) {
  if (!card) return null;
  return <section className="proximity-card" role="region" aria-label={onClose ? 'Selected panda' : 'Nearby panda'}>
    {onClose ? <button type="button" className="proximity-close" aria-label="Close panda card" onClick={onClose}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" /></svg>
    </button> : null}
    <header>
      <p className="proximity-team">{card.team} · {card.role} · {card.runtime==='codex'?'Codex':'Claude'}</p>
      <h2>{card.name || card.role}</h2>
      <p className="proximity-project">Current project · {card.projectId || 'Project identity unavailable'}</p>
      <p className="proximity-state">{STATE_LABELS[card.state] || card.state}</p>
    </header>
    {card.ref ? <p className="proximity-ticket">{card.ref}</p> : null}
    {card.presentation ? <p className="proximity-state">{card.presentation}</p> : null}
    {card.tool ? <p className="proximity-tool"><strong>{card.tool.name}</strong>{card.tool.summary ? ` · ${card.tool.summary}` : ''}</p> : null}
    {card.approval ? <p className="proximity-pending"><span className="proximity-lantern" aria-hidden="true" />{pendingLine(card)}</p> : null}
    {card.last ? <div className="proximity-result">
      <p className="proximity-last"><strong>{card.last.label}</strong>{card.last.ref ? <span>{card.last.ref}</span> : null}{card.last.cost ? <span className="proximity-cost" title={card.last.costExact}>{card.last.cost}</span> : null}</p>
      {card.last.reply ? <p className="proximity-reply">{card.last.reply}</p> : null}
    </div> : null}
    <div className="proximity-actions">
      {toolActivity ? <button type="button" onClick={onInspectTools}>Inspect {toolActivity.count} active tool {toolActivity.count===1?'call':'calls'}</button> : null}
      {Object.entries(LABELS).map(([key, base]) => {
        const starts = key === 'T' && card.start;
        const label = starts ? START.label : base;
        const answer = key === 'Q' || key === 'E';
        const enabled = key === 'R' ? card.actions.R.enabled : key === 'T' ? card.actions.T.enabled && !demo : card.actions[key].enabled && !demo;
        const onClick = key === 'R' ? () => onTranscript?.(card) : key === 'T' ? () => onMessage?.(card) : () => onAnswer?.(card);
        const reason = (answer || key === 'T') && demo ? DEMO_REASON : card.actions[key].reason || (starts ? START.next : NEXT[key]);
        return <div key={key}>
          <button type="button" data-key={key} disabled={!enabled} aria-pressed={key === 'R' ? transcriptOpen : undefined} onClick={onClick} aria-describedby={`proximity-reason-${key}`}><kbd>{key}</kbd> {label}</button>
          <span id={`proximity-reason-${key}`}>{reason}</span>
        </div>;
      })}
    </div>
    {status ? <p className="proximity-message" data-kind={status.kind}><span className="proximity-message-dot" aria-hidden="true" /><strong>{status.label}</strong> <span className="proximity-message-preview">{status.preview}</span></p> : null}
  </section>;
}
