// Ticket 40 public projections/buffering: exact sources are independent of display position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadEntries, threadView } from './thread-model.mjs';
import { transcriptView, RESULT_BYTES } from './transcript-view.mjs';
import { appendTranscript } from '../state/transcript-buffer.mjs';
import { source, unsafeText, probes } from '../../../bridge/agents/fixtures/transcript-tools-40.mjs';

const RUN = 'c-0011223344556677', OLD = 'c-8899aabbccddeeff';
const tool = (runId, id, extra = {}) => ({ id, runId, kind: 'tool', name: 'Bash', summary: 'echo safe', status: 'running', invocationId: `call-${id}`, source: source(runId, id), ...extra });

test('40 source: row attribution and deliberate expansion survive loading earlier pages with reused entry ids', () => {
  const target = tool(OLD, 1);
  const current = tool(RUN, 1);
  const args = { history: [target], buffer: { entries: [current], dropped: 0 }, agentId: RUN };
  const before = threadView(threadEntries(args), { expanded: [target.source] });
  assert.deepEqual(before.rows.map(r => r.source), [target.source, current.source]);
  assert.equal(before.rows[0].expanded, true);
  assert.equal(before.rows[1].expanded, false, 'reused id must not expand another run');
  const earlier = tool('c-aaaaaaaaaaaaaaaa', 1);
  const after = threadView(threadEntries({ ...args, history: [earlier, target] }), { expanded: [target.source] });
  assert.equal(after.rows.find(r => r.source?.runId === OLD)?.expanded, true, 'prepending history cannot move the chosen expansion');
  assert.equal(after.rows.filter(r => r.expanded).length, 1);
});

test('40 source: missing legacy attribution remains unavailable instead of borrowing the current run tuple', () => {
  const list = threadEntries({ history: [{ kind: 'tool', id: 1, name: 'Read', status: 'done', result: 'legacy' }], buffer: { entries: [], dropped: 0 }, agentId: RUN });
  const row = threadView(list).rows[0];
  assert.equal(row.source ?? null, null);
  assert.equal(row.sourceUnavailable, true, 'the caller can present a truthful unavailable source');
});

test('40 view: an expanded invocation with no recorded result explicitly says Not available yet', () => {
  const row = transcriptView({ entries: [tool(RUN, 1)] }, { expanded: [1] }).rows[0];
  assert.equal(row.resultLabel, 'Not available yet');
  assert.equal(row.result, null);
  assert.equal(row.inputText, '', 'no invocation arguments may be invented from summary');
});

test('40 view: end without proven success reads Ended, including durable-history rows', () => {
  const row = threadView({ entries: [tool(OLD, 1, { status: 'ended' })] }).rows[0];
  assert.equal(row.statusLabel, 'Ended');
});

test('40 defense in depth: malformed result/input never fall through to raw object serialization', () => {
  const row = transcriptView({ entries: [tool(RUN, 1, { input: ['RAW-INPUT-40'], result: { unrecognized: 'RAW-RESULT-40' } })] }, { expanded: [1] }).rows[0];
  assert.equal(JSON.stringify(row).includes('RAW-INPUT-40'), false);
  assert.equal(JSON.stringify(row).includes('RAW-RESULT-40'), false);
});

test('40 buffer: replaying an earlier active frame cannot erase an authoritative terminal result', () => {
  const active = tool(RUN, 1);
  let buffers = appendTranscript({}, RUN, active);
  buffers = appendTranscript(buffers, RUN, { ...active, status: 'failed', result: 'recorded failure' });
  buffers = appendTranscript(buffers, RUN, active);
  assert.equal(buffers[RUN].entries.length, 1);
  assert.equal(buffers[RUN].entries[0].status, 'failed');
  assert.equal(buffers[RUN].entries[0].result, 'recorded failure');
});

test('40 defense in depth: input, preview and result projections redact synthetic probes before disclosure', () => {
  const row = transcriptView({ entries: [tool(RUN, 1, { summary: unsafeText(), input: { command: unsafeText() }, result: unsafeText() })] }, { expanded: [1] }).rows[0];
  for (const probe of probes) assert.equal(JSON.stringify(row).includes(probe), false, 'no raw secret in a view field');
  assert.match(JSON.stringify(row), /masked|redacted/i);
});

// Baseline guards deliberately pass without ticket 40; they protect existing public behavior.
test('40 baseline: tools default collapsed and bounded Unicode results report truthful truncation', () => {
  const entry = tool(RUN, 1, { result: '界'.repeat(2000) });
  assert.equal(transcriptView({ entries: [entry] }).rows[0].expanded, false);
  const row = transcriptView({ entries: [entry] }, { expanded: [1] }).rows[0];
  assert.ok(Buffer.byteLength(row.result.text) <= RESULT_BYTES);
  assert.equal(row.result.text.includes('�'), false);
  assert.ok(row.result.truncatedBytes > 0);
});

test('40 baseline: reading earlier entries preserves unread count and separately actionable permission identity', () => {
  const approvalId = 'a-0011223344556677';
  const list = { entries: [tool(RUN, 1), { id: 2, n: 2, runId: RUN, kind: 'permission', name: 'Bash', status: 'pending', approvalId }] };
  const view = threadView(list, { atBottom: false, seenThrough: 1, approvals: [{ id: approvalId, agentId: RUN, tool: 'Bash', state: 'pending' }], agents: [{ id: RUN, state: 'waiting_on_user' }] });
  assert.equal(view.unread, 1);
  assert.equal(view.rows[1].approvalId, approvalId);
  assert.equal(view.rows[1].answerable, true);
});
