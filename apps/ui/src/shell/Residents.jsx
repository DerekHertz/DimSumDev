import { useId, useState } from 'react';
import { deskResidents } from './desk-model.mjs';
import { ROLE_PORTRAITS } from './role-portraits.mjs';
import { RESIDENTS, RUNTIME_UNAVAILABLE } from './resident-inventory.mjs';

const STATES = { resident: 'At home', working: 'Working', 'needs-you': 'Needs you', blocked: 'Blocked',idle:'Idle',throttled:'Throttled' };
const BADGES = {
  orchestrator: 'B', product: 'P', architect: 'A', developer: 'M', scout: 'S', runner:'R', debugger: 'D',
  qa: 'T', security: 'G', designer: 'S', herald: 'H', 'release-manager': 'D',
  'knowledge-keeper': 'L', 'docs-writer': 'P', 'stem-cub': 'C',
};

function Portrait({ row, large = false }) {
  return <span className={`forest-portrait${large ? ' forest-portrait-large' : ''}`} data-role={row.role} aria-hidden="true">
    <img src={ROLE_PORTRAITS[row.runtime==='codex'?`codex:${row.role}`:row.role]} alt="" width="512" height="512" />
    <span className="forest-portrait-badge">{row.name==='Jiao'?'J':BADGES[row.role]}</span>
  </span>;
}

// Selection only opens a profile. The parent connects these explicit actions to the live bridge flows.
export function Residents({ snapshot, now, bindings, onTalk, onViewWork, getTalkState }) {
  const [selectedId, setSelectedId] = useState('orchestrator');
  const profileId = useId();
  const rows = deskResidents(snapshot, { now, bindings });
  const selected = rows.find(row => row.id === selectedId)
    ?? rows.find(row => row.id === selectedId.split('#')[0]) ?? rows[0];
  const talkState = selected.runtime==='codex'?{enabled:false,reason:RUNTIME_UNAVAILABLE}:getTalkState?.(selected) ?? { enabled: !!onTalk, reason: onTalk ? null : 'Conversation unavailable.' };
  const canTalk = !!onTalk && talkState.enabled;
  const canViewWork = selected.runtime==='claude' && !!onViewWork && !!selected.ref;
  const visitors = rows.filter(row => row.visitor).length;

  return <section className="forest-residents" aria-label="Panda profiles">
    <p className="forest-muted forest-residents-intro">{RESIDENTS.length} residents{visitors ? ` · ${visitors} ${visitors === 1 ? 'visitor' : 'visitors'}` : ''}. Pick a panda to visit.</p>
    <section className="forest-profile" aria-labelledby={profileId}>
      <header className="forest-profile-heading">
        <Portrait row={selected} large />
        <div>
          <p className="forest-eyebrow">{selected.team}{selected.visitor ? ' · Visitor' : ''}</p>
          <h3 id={profileId}>{selected.name}</h3>
          <p className="forest-profile-role">{selected.role} · {selected.runtime==='codex'?'Codex':'Claude'}</p>
          <p className="forest-profile-project">Current project · {selected.projectId || 'Project identity unavailable'}</p>
        </div>
      </header>
      <div className="forest-profile-activity" aria-live="polite" aria-atomic="true">
        <p className="forest-profile-state"><span className={`forest-dot state-${selected.state}`} aria-hidden="true" />{STATES[selected.state] ?? selected.state}</p>
        <p className="forest-profile-task">{selected.task || selected.ref || 'No active work right now.'}</p>
        {selected.bubble ? <p className="forest-profile-tool">{selected.bubble}</p> : null}
      </div>
      <div className="forest-profile-actions">
        <button type="button" className="btn btn-solid" disabled={!canTalk} onClick={() => onTalk(selected)} aria-describedby={!canTalk ? `${profileId}-talk-reason` : undefined}>Talk to {selected.name.replace(/^The /, '')}</button>
        <button type="button" className="btn" disabled={!canViewWork} onClick={() => onViewWork(selected)} aria-describedby={!canViewWork ? `${profileId}-work-reason` : undefined}>View work <span aria-hidden="true">↗</span></button>
      </div>
      {!canTalk ? <p id={`${profileId}-talk-reason`} className="forest-profile-reason">{talkState.reason || 'Conversation unavailable.'}</p> : null}
      {!canViewWork ? <p id={`${profileId}-work-reason`} className="forest-profile-reason">{selected.ref ? 'Work details unavailable.' : 'No active ticket to view.'}</p> : null}
    </section>
    <ul className="forest-portrait-list" aria-label="Residents and visitors">{rows.map(row => <li key={row.id}>
      <button type="button" className="forest-portrait-choice" onClick={() => setSelectedId(row.id)} aria-pressed={selected.id === row.id} aria-label={`${row.name}, ${row.role}, ${row.runtime==='codex'?'Codex':'Claude'}, ${row.projectId||'current project identity unavailable'}${row.visitor ? `, visitor on ${row.ref}` : ''}, ${STATES[row.state] ?? row.state}`}>
        <Portrait row={row} />
        <span className="forest-portrait-name">{row.name.replace(/^The /, '')}</span><span className="forest-portrait-runtime">{row.runtime==='codex'?'Codex':'Claude'}</span>
        <span className="forest-portrait-caption"><span className={`forest-dot state-${row.state}`} aria-hidden="true" />{row.visitor ? 'Visitor' : STATES[row.state] ?? row.state}</span>
      </button>
    </li>)}</ul>
  </section>;
}
