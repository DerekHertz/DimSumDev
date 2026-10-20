import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadEntries, threadView } from './thread-model.mjs';
import { transcriptView } from './transcript-view.mjs';
import { source } from '../../../bridge/agents/fixtures/transcript-tools-40.mjs';

const RUN = 'c-0011223344556677';
const tool = extra => ({ id: 1, runId: RUN, kind: 'tool', name: 'Read', status: 'running', source: source(RUN, 1), ...extra });

test('40 history: repeated source rows fold without erasing terminal output on active replay', () => {
  const active = tool({});
  const done = tool({ status: 'done', result: 'authoritative result' });
  const view = threadView(threadEntries({ history: [done, active, done], agentId: RUN }), { expanded: [done.source] });
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].status, 'done');
  assert.equal(view.rows[0].result.text, 'authoritative result');
});

test('40 history: only an exact live source replaces its history counterpart', () => {
  const current = tool({});
  const other = tool({ source: source(RUN, 1, { project: 'other-project' }), result: 'different source', status: 'done' });
  const list = threadEntries({ history: [other, current], buffer: { entries: [current], dropped: 0 }, agentId: RUN });
  assert.equal(list.entries.length, 2);
  assert.equal(list.entries[0].result, 'different source');
});

test('40 result: Unicode truncation reports the exact number of omitted bytes', () => {
  const full = '界'.repeat(2000);
  const row = transcriptView({ entries: [tool({ result: full })] }, { expanded: [1] }).rows[0];
  assert.equal(Buffer.byteLength(row.result.text) + row.result.truncatedBytes, Buffer.byteLength(full));
});
