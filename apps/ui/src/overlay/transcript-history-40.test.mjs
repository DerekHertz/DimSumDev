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

test('40 history: durable terminal output survives a stale running live row with stable live numbering', () => {
  const done = tool({ status: 'done', result: 'durable final output' });
  const active = tool({ n: 19 });
  const list = threadEntries({ history: [done], buffer: { entries: [active], dropped: 18 }, agentId: RUN });
  const [row] = threadView(list, { expanded: [done.source] }).rows;
  assert.equal(list.entries.length, 1);
  assert.equal(row.n, 19);
  assert.equal(row.status, 'done');
  assert.equal(row.result?.text, 'durable final output');
  assert.deepEqual(row.source, done.source);
  assert.equal(active.status, 'running', 'reconciliation does not mutate the live buffer');
});

test('40 history: terminal live output wins over stale history and terminal history cannot erase newer live output', () => {
  const live = tool({ status: 'failed', result: 'newer live output' });
  for (const stale of [tool({}), tool({ status: 'ended' }), tool({ status: 'done', result: 'older history output' })]) {
    const list = threadEntries({ history: [stale], buffer: { entries: [live] }, agentId: RUN });
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].status, 'failed');
    assert.equal(list.entries[0].result, 'newer live output');
  }
});

test('40 history: late recorded result revisions supersede an output-free end in either history or live', () => {
  const ended = tool({ status: 'ended' });
  const done = tool({ status: 'done', result: 'late recorded result' });
  for (const [history, live] of [[done, ended], [ended, done]]) {
    const [row] = threadView(threadEntries({ history: [history], buffer: { entries: [live] }, agentId: RUN }), { expanded: [done.source] }).rows;
    assert.equal(row.status, 'done');
    assert.equal(row.result?.text, 'late recorded result');
  }
});

test('40 result: Unicode truncation reports the exact number of omitted bytes', () => {
  const full = '界'.repeat(2000);
  const row = transcriptView({ entries: [tool({ result: full })] }, { expanded: [1] }).rows[0];
  assert.equal(Buffer.byteLength(row.result.text) + row.result.truncatedBytes, Buffer.byteLength(full));
});
