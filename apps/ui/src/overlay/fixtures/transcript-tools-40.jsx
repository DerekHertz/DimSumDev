// Test-only mount of the actual conversation panel; no scene, bridge connection or agent process.
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TranscriptPanel, useTranscript } from '../TranscriptPanel.jsx';
import { appendTranscript } from '../../state/transcript-buffer.mjs';
import '../../styles.css';
import '../../scene/procedural/den.css';
import '../../shell/forest.css';

function Harness() {
  const fixture = window.tools40Fixture;
  const [transcripts, setTranscripts] = useState(fixture.transcripts);
  const [mounted, setMounted] = useState(true);
  const tx = useTranscript({ card: null, exploring: false, returnFocus: () => { document.querySelector('#tools40-open')?.focus(); return true; } });
  const client = useMemo(() => ({
    getConversation: async (role, options) => {
      window.tools40Reads.push({ role, ...options });
      if (window.tools40HistoryError) throw { reason: 'Synthetic history failure' };
      return fixture.pages[Math.min(window.tools40Reads.length - 1, fixture.pages.length - 1)];
    },
    converse: async (role, body) => { window.tools40Posts.push({ role, body }); return { runId: fixture.run, messageId: 'm', resumed: false }; },
    stopAgent: async (id) => { window.tools40Posts.push({ stop: id }); return { ok: true }; },
  }), []);
  useEffect(() => {
    window.tools40 = {
      // Optional third argument extends the existing public openFor seam; two-argument callers remain valid.
      open: (source, expandTool = true) => tx.openFor(fixture.run, fixture.who, source ? { source, expandTool } : undefined),
      close: tx.close,
      append: (entry) => setTranscripts(previous => appendTranscript(previous, fixture.run, entry)),
      mount: setMounted,
    };
  });
  return <div className="forest-shell den-shell">
    <button id="tools40-open" onClick={() => tx.openFor(fixture.run, fixture.who)}>Open conversation</button>
    <main aria-label="Den scene" tabIndex={-1}>
      {mounted && <TranscriptPanel tx={tx} transcripts={transcripts} agents={fixture.agents} approvals={fixture.approvals ?? []} connection={{ phase: 'online' }} client={client} />}
    </main>
  </div>;
}
const root = createRoot(document.querySelector('#root'));
window.tools40Unmount = () => root.unmount();
root.render(<Harness />);
