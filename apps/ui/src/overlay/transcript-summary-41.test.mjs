import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptSummary } from './transcript-summary.mjs';

const scope = { project: 'den', runtime: 'claude', role: 'developer', runId: 'run-41' };
const message = (id, role, text, extra = {}) => ({ id, runId: scope.runId, kind: 'message', role, text, source: { ...scope, entryId: id }, ...extra });
const summarize = entries => transcriptSummary(entries, { ...scope, resumeOf: 'previous-run' });

test('41: selected initiating scope and latest visible agent update retain exact durable citations', () => {
  const task = message(1, 'user', 'Fix **the transcript** without extra calls.');
  const update = message(8, 'agent', 'Checking [focused tests](https://example.test/tests), then reviewing.');
  const entries = [task, message(2, 'agent', 'Starting.'), message(3, 'user', 'A later instruction'),
    message(4, 'agent', 'Another run', { source: { ...scope, runId: 'other', entryId: 4 } }),
    { ...message(5, 'agent', 'Tool noise'), kind: 'tool' },
    { ...message(6, 'agent', 'Permission noise'), kind: 'permission' },
    message(7, 'system', 'Transport noise'), update, message(9, 'agent', '  '),
    message(10, 'agent', 'Hidden reasoning', { channel: 'analysis' }), message(11, 'agent', 'Hidden', { hidden: true }),
    message(12, 'agent', 'Permission transport boilerplate', { boilerplate: true }),
    message(13, 'agent', 'Waiting for approval…'), message(14, 'agent', '[Request interrupted by user for tool use]'),
    message(15, 'agent', 'Reconnecting...')];
  const summary = summarize(entries);
  assert.deepEqual(summary.task, { text: 'Fix the transcript without extra calls.', source: task.source });
  assert.deepEqual(summary.update, { text: 'Checking focused tests, then reviewing.', source: update.source });
});

test('41: absent initiating entry never substitutes a later user message or another context', () => {
  for (const foreign of [{ runId: 'old' }, { runtime: 'codex' }, { project: 'elsewhere' }, { role: 'qa' }]) {
    assert.equal(summarize([message(1, 'user', 'Wrong task', { source: { ...scope, ...foreign, entryId: 1 } }), message(5, 'user', 'Later follow-up')]).task, null);
  }
  assert.deepEqual(summarize([]), { task: null, update: null });
  assert.equal(summarize([message(1, 'agent', 'Task never recorded'), message(2, 'user', 'Follow-up')]).task, null);
  assert.equal(summarize([message(1, 'user', 'No locator', { source: undefined })]).task, null);
  assert.equal(summarize([message(1, 'user', 'Mismatch', { runId: 'old' })]).task, null);
  assert.equal(transcriptSummary([message(1, 'user', 'Immediate in-run message')], scope).task, null, 'entry 1 alone cannot prove task provenance');
});

test('41: history and authoritative revisions stay ordered by scoped entry identity, not timestamps or neighboring runs', () => {
  const task = message(1, 'user', 'Follow-up run starts here.');
  const update = message(20, 'agent', 'Checking tests', { at: '2000-01-01' });
  assert.deepEqual(summarize([update, message(4, 'agent', 'Old update', { at: '2100-01-01' }), task]).update.source, update.source);
  assert.equal(summarize([task, { ...update, text: 'Tests passed' }]).update.text, 'Tests passed');
  assert.equal(summarize([task, update]).update.text, 'Checking tests');
  assert.equal(summarize([task, task]).task, null, 'ambiguous exact identity is unavailable');
  const marker = { id: 0, kind: 'run', resumeOf: 'earlier-run', source: { ...scope, entryId: 0 } };
  assert.equal(transcriptSummary([marker, task], scope).task.text, task.text, 'retained run marker supplies historical launch provenance');
  assert.equal(transcriptSummary([{ ...marker, source: { ...marker.source, runId: 'other' } }, task], scope).task, null);
});

test('41: excerpt allocation is combined and bounded, clips with ellipsis, and lends unused budget', () => {
  const result = summarize([message(1, 'user', 't'.repeat(400)), message(2, 'agent', 'u'.repeat(400))]);
  assert.equal(result.task.text.length + result.update.text.length, 320);
  assert.ok(result.task.text.endsWith('…') && result.update.text.endsWith('…'));
  const shortTask = summarize([message(1, 'user', 'Fix it.'), message(2, 'agent', 'u'.repeat(400))]);
  assert.equal(shortTask.task.text.length + shortTask.update.text.length, 320);
});

test('41: redact before markup removal and clipping, retaining attribution even for fully masked text', () => {
  const token = ['gh', 'p_', 'q'.repeat(36)].join('');
  const result = summarize([message(1, 'user', 'x'.repeat(140) + token + ' tail'), message(2, 'agent', token)]);
  const exposed = JSON.stringify(result);
  assert.ok(!exposed.includes(token) && !exposed.includes(token.slice(0, 15)));
  assert.equal(result.update.text, '[masked: possible secret]');
  assert.deepEqual(result.update.source, { ...scope, entryId: 2 });
  const fullyMaskedTask = summarize([message(1, 'user', token)]);
  assert.equal(fullyMaskedTask.task.text, '[masked: possible secret]');
  assert.deepEqual(fullyMaskedTask.task.source, { ...scope, entryId: 1 });
  const formattedToken = token.slice(0, 2) + '**' + token.slice(2, 5) + '**' + token.slice(5);
  assert.equal(summarize([message(1, 'user', formattedToken)]).task.text, '[masked: possible secret]', 'markup removal must not reveal a newly joined credential');
  assert.match(summarize([message(1, 'user', 'Safe\u202E text')]).task.text, /\\u202e/);
});

test('41: tool bursts cannot change the summary or invoke a client, callback or inference API', () => {
  const entries = [message(1, 'user', 'Read the task.'), message(2, 'agent', 'Checking tests.')];
  const before = summarize(entries);
  const after = summarize([...entries, ...Array.from({ length: 50 }, (_, i) => ({ kind: 'tool', id: i + 3, text: 'Passed', source: { ...scope, entryId: i + 3 } }))]);
  assert.deepEqual(after, before);
  assert.deepEqual(Object.keys(after), ['task', 'update']);
  assert.deepEqual(entries.map(e => e.text), ['Read the task.', 'Checking tests.']);
});
