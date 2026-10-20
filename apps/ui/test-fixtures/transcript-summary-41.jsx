// Mounted production transcript with controlled history and live updates; no bridge or scene.
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TranscriptPanel, useTranscript } from '../src/overlay/TranscriptPanel.jsx';
import '../src/styles.css';
import '../src/scene/procedural/den.css';
import '../src/shell/forest.css';

function Harness() {
  const fixture = window.summary41Fixture;
  const [transcripts, setTranscripts] = useState(fixture.transcripts);
  const tx = useTranscript({ card: null, exploring: false });
  const client = useMemo(() => new Proxy({
    getConversation: (role, options) => {
      window.summary41Calls.push({ method: 'getConversation', role, options });
      if (fixture.historyPending) return new Promise((resolve, reject) => { window.summary41History = { resolve, reject }; });
      return Promise.resolve(fixture.history ?? { entries: [], more: false, before: 0 });
    },
  }, { get: (target, key) => target[key] ?? (() => { window.summary41Calls.push({ method: String(key) }); throw new Error(`Unexpected client call: ${String(key)}`); }) }), []);
  useEffect(() => { window.summary41 = { open: (run = fixture.run) => tx.openFor(run, fixture.who), setTranscripts, close: tx.close }; });
  return <div className="forest-shell den-shell"><main aria-label="Den scene" tabIndex={-1}>
    <TranscriptPanel tx={tx} transcripts={transcripts} agents={fixture.agents} approvals={[]} connection={{ phase: 'online' }} client={client} />
  </main></div>;
}
createRoot(document.getElementById('root')).render(<Harness />);
