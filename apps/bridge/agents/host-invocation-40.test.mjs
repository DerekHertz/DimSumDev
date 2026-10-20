import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeBridge, openSse, until, send } from './host-test-helpers.mjs';
import { parseClaudeLine } from './claude-adapter.mjs';

// Synthetic fixtures only. Include a token crossing the old 200-character cutoff,
// two distinct oversized identities with the same prefix, and unsafe short identities.
const secret = 'sk-' + 'a'.repeat(40);
const rejected = ['p'.repeat(190) + secret, 'q'.repeat(200) + 'one', 'q'.repeat(200) + 'two', secret, 'bad\u0007id'];
const start = (id, index = 0) => parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [
  { type: 'tool_use', id, name: 'Bash', input: { command: 'echo recorded safe input', index } },
] } }));
const result = (id, content) => parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [
  { type: 'tool_result', tool_use_id: id, content },
] } }));

test('40 invocation adapter: reject original unsafe and oversized IDs without truncating or altering valid IDs', () => {
  for (const [index, id] of rejected.entries()) {
    const events = [...start(id, index), ...result(id, 'safe result')];
    assert.equal(events.every(event => event.id === ''), true, `rejected identity ${index} must remain uncorrelated`);
    assert.equal(JSON.stringify(events).includes(secret.slice(0, 10)), false, 'normalization must not expose a clipped synthetic token');
  }
  for (const id of ['safe-call', 'v'.repeat(200)]) {
    assert.deepEqual([...start(id), ...result(id, 'safe result')].map(event => event.id), [id, id, id]);
  }
});

test('40 invocation bridge: rejected adapter identities never leak or collide through wire, snapshot or durable history', { timeout: 20000 }, async t => {
  const b = await makeBridge();
  t.after(() => b.close());
  const sse = openSse(b.bridge);
  await sse.opened;
  t.after(() => sse.close());
  const dispatched = await b.dispatch('architect');
  assert.equal(dispatched.status, 201, dispatched.text);
  const runId = dispatched.body.agent.id;
  for (const [index, id] of rejected.entries()) {
    for (const event of [...start(id, index), ...result(id, 'unmatched result must stay absent')]) b.fake.spawns[0].emit(event);
  }
  for (const event of [...start('safe-call'), ...result('safe-call', 'safe correlated output')]) b.fake.spawns[0].emit(event);
  await until(async () => (await b.state()).transcripts[runId]?.entries.some(e => e.result === 'safe correlated output'), { what: 'valid correlated result' });
  const state = await b.state();
  const page = await send(b.bridge, { path: '/conversations/architect?runtime=claude&project=den&limit=100', headers: b.headers });
  assert.equal(page.status, 200, page.text);
  await sse.next(frame => frame.data.entry?.result === 'safe correlated output');
  const file = await readFile(path.join(b.fx.root, '.scratch/_run/conversations/architect.jsonl'), 'utf8');
  for (const [where, value] of [['wire', sse.frames], ['snapshot', state], ['history', page.body], ['persisted', file]]) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert.equal(text.includes(secret.slice(0, 10)), false, `${where} exposes a synthetic credential fragment`);
    assert.equal(text.includes('unmatched result must stay absent'), false, `${where} must not pair an unknown result`);
  }
  const tools = state.transcripts[runId].entries.filter(e => e.kind === 'tool');
  assert.equal(tools.length, rejected.length + 1, 'oversized identities cannot collapse distinct recorded invocations');
  for (const entry of tools.slice(0, -1)) {
    assert.equal(entry.invocationId, undefined);
    assert.equal(entry.result, undefined);
    assert.equal(entry.status, 'running');
    assert.equal(entry.input.command, 'echo recorded safe input');
    const kept = page.body.entries.find(e => e.source?.entryId === entry.id && e.source?.runId === runId);
    assert.deepEqual(kept?.source, entry.source, 'safe exact-source lookup remains available for uncorrelated tools');
  }
  assert.equal(tools.at(-1).invocationId, 'safe-call');
  assert.equal(tools.at(-1).status, 'done');
  assert.equal(tools.at(-1).result, 'safe correlated output');
});
