// Supplemental history-race fixture: actual panel/hook, controlled promises, no scene or bridge.
import React, { useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { TranscriptPanel, useTranscript } from '../TranscriptPanel.jsx';
import '../../styles.css';
import '../../shell/forest.css';

function Harness() {
  const fixture = window.navigation40Fixture;
  const tx = useTranscript({ card: null, exploring: false });
  const client = useMemo(() => ({
    getConversation: (role, options) => new Promise((resolve, reject) => window.navigation40Reads.push({ role, options, resolve, reject })),
  }), []);
  useEffect(() => { window.navigation40 = { open: (run, source) => tx.openFor(run, fixture.who, source ? { source, expandTool: true } : undefined), close: tx.close }; });
  return <div className="forest-shell den-shell"><main aria-label="Den scene" tabIndex={-1}>
    <TranscriptPanel tx={tx} client={client} transcripts={fixture.transcripts} agents={fixture.agents} approvals={[]} connection={{ phase: 'online' }} />
  </main></div>;
}
createRoot(document.getElementById('root')).render(<Harness />);
