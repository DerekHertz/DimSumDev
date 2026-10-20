import { useState } from 'react';
import { transcriptSummary } from './transcript-summary.mjs';

export function TranscriptSummary({ entries, scope, onSource }) {
  const [collapsed, setCollapsed] = useState(false);
  const summary = transcriptSummary(entries, scope);
  const fields = [
    { key: 'task', label: 'Task', sourceLabel: 'Source for task', missing: 'Task scope not loaded' },
    { key: 'update', label: 'Latest update', sourceLabel: 'Source for latest update', missing: 'No agent update yet' },
  ];
  return <section className="transcript-summary" aria-label="Summary">
    <div className="transcript-summary-head">
      <div><h3>Summary</h3><p>From source messages</p></div>
      <button type="button" className="transcript-summary-toggle" aria-label={collapsed ? 'Expand summary' : 'Collapse summary'} aria-expanded={!collapsed} aria-controls="transcript-summary-content" onClick={() => setCollapsed(value => !value)}>{collapsed ? 'Expand' : 'Collapse'}</button>
    </div>
    <div id="transcript-summary-content" className={collapsed ? 'transcript-summary-sources' : 'transcript-summary-fields'}>
      {fields.map(({ key, label, sourceLabel, missing }) => <div className="transcript-summary-field" key={key}>
        {collapsed ? null : <span className="transcript-summary-label">{label}</span>}
        {summary[key] ? <button type="button" className="transcript-summary-source" aria-label={sourceLabel} onClick={() => onSource(summary[key].source)}>{collapsed ? `${label} source` : 'Source'}</button> : null}
        {collapsed ? null : <p className={`transcript-summary-excerpt${summary[key] ? '' : ' transcript-summary-missing'}`}>{summary[key]?.text ?? missing}</p>}
      </div>)}
    </div>
  </section>;
}
