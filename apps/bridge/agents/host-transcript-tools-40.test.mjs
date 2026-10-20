// Ticket 40: public runtime events -> actual bridge wire, snapshot and durable history.
// New view contract: source is the composite tuple, invocationId is the runtime's actual id.
// Safe recorded input may be structured JSON or text; no raw permission input is exposed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeBridge, openSse, until, send, FEATURE } from './host-test-helpers.mjs';
import { parseClaudeLine, BODY_MAX } from './claude-adapter.mjs';
import { TRANSCRIPT_RESULT_MAX } from './policy.mjs';
import { probes, unsafeText, secret, source } from './fixtures/transcript-tools-40.mjs';

async function setup(t, options) {
  const bridge = await makeBridge(options);
  t.after(() => bridge.close());
  const sse = openSse(bridge.bridge);
  await sse.opened;
  t.after(() => sse.close());
  const started = await bridge.dispatch('architect');
  assert.equal(started.status, 201, started.text);
  const run = started.body.agent;
  const emit = async (...events) => {
    for (const event of events) bridge.fake.spawns[0].emit(event);
    const marker = `barrier-${++sequence}`;
    bridge.fake.spawns[0].emit({ type: 'text', text: marker });
    await until(async () => (await bridge.state()).transcripts[run.id]?.entries.some(e => e.text === marker), { what: marker });
  };
  return { ...bridge, sse, run, emit, entries: async () => (await bridge.state()).transcripts[run.id].entries.filter(e => e.kind === 'tool'), history: () => send(bridge.bridge, { path: '/conversations/architect?runtime=claude&project=den&limit=100', headers: bridge.headers }) };
}
let sequence = 0;
const start = (id, summary = id, extra = {}) => ({ type: 'tool-start', id, name: 'Bash', summary, ...extra });
const result = (id, text = `result-${id}`, extra = {}) => ({ type: 'tool-result', id, text, ok: true, ...extra });
function noSecrets(value, where) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const probe of probes) assert.equal(text.includes(probe), false, `${where} leaks synthetic probe`);
  assert.equal(text.includes(String.fromCharCode(7)), false, `${where} raw control`);
  assert.equal(text.includes(String.fromCharCode(0x202e)), false, `${where} raw bidi`);
}

test('40 adapter: actually recorded invocation input survives safely; malformed input has no raw fallback', () => {
  const line = input => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input }] } });
  const call = parseClaudeLine(line({ command: 'echo recorded', note: unsafeText() })).find(e => e.type === 'tool-start');
  assert.ok(call?.input !== undefined, 'recorded tool_use input must be available, rather than invented from summary');
  assert.match(JSON.stringify(call.input), /echo recorded/);
  noSecrets(call, 'normalized runtime event');
  assert.match(JSON.stringify(call), /masked|redacted/i);
  const malformed = parseClaudeLine(line(['MALFORMED-RAW-40'])).find(e => e.type === 'tool-start');
  assert.equal(JSON.stringify(malformed).includes('MALFORMED-RAW-40'), false, 'invalid input must not fall back to serialization');
});

test('40 adapter disclosure: redact before summary extraction and runtime body clipping, including distinctive partial tokens', () => {
  const invocation = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'boundary', name: 'Bash', input: { command: 'p'.repeat(190) + secret } }] } }));
  const completion = parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'boundary', content: 'r'.repeat(BODY_MAX - 10) + secret + ' tail' }] } }));
  for (const events of [invocation, completion]) {
    assert.equal(JSON.stringify(events).includes(secret.slice(0, 10)), false, 'a clipped credential prefix is still a disclosure');
    assert.match(JSON.stringify(events), /masked|redacted/i, 'mask the recognized secret before extracting/clipping');
  }
});

test('40 bridge: recorded safe input and durable composite source survive wire, snapshot and history revisions', { timeout: 20000 }, async t => {
  const b = await setup(t);
  await b.emit(start('call-a', 'echo recorded', { input: { command: 'echo recorded' } }), result('call-a'));
  const [entry] = await b.entries();
  assert.deepEqual(entry.source, source(b.run.id, entry.id));
  assert.equal(entry.invocationId, 'call-a');
  assert.match(JSON.stringify(entry.input), /echo recorded/);
  const page = await b.history();
  assert.equal(page.status, 200, page.text);
  const kept = page.body.entries.find(e => e.runId === b.run.id && e.id === entry.id);
  assert.deepEqual(kept.source, entry.source);
  assert.equal(kept.invocationId, 'call-a');
  assert.deepEqual(kept.input, entry.input);
  assert.equal(kept.result, 'result-call-a');
  await b.sse.next(f => f.data.type === 'transcript' && f.data.entry?.result === 'result-call-a');
  const frames = b.sse.frames.filter(f => f.data.type === 'transcript' && f.data.entry?.kind === 'tool');
  assert.ok(frames.length >= 2);
  for (const f of frames) assert.deepEqual(f.data.entry.source, entry.source, 'revisions retain exact attribution');
});

test('40 lifecycle: duplicate and replayed same-name calls do not multiply or resurrect completed invocations', { timeout: 20000 }, async t => {
  const b = await setup(t);
  await b.emit(start('a'), start('b'), start('a'), result('a'), result('a'), start('a'));
  const tools = await b.entries();
  assert.equal(tools.length, 2, 'duplicate/replayed starts retain one row per invocation');
  assert.equal(tools.find(e => e.invocationId === 'a')?.status, 'done');
  assert.equal(tools.find(e => e.invocationId === 'b')?.status, 'running');
  await b.emit(result('b', 'only-b', { ok: false }));
  assert.deepEqual((await b.entries()).map(e => [e.invocationId, e.status, e.result]), [['a', 'done', 'result-a'], ['b', 'failed', 'only-b']]);
});

test('40 lifecycle: unidentified end is ambiguous across concurrent same-name calls and proves no success', { timeout: 20000 }, async t => {
  const b = await setup(t);
  await b.emit(start('a'), start('b'), { type: 'tool-end' });
  assert.equal((await b.entries()).filter(e => e.status === 'done').length, 0, 'an end without correlation cannot complete the latest matching name');
  await b.emit({ type: 'tool-end', id: 'a' });
  const tools = await b.entries();
  assert.equal(tools.find(e => e.invocationId === 'a')?.status, 'ended', 'an end without a success result means Ended');
  assert.equal(tools.find(e => e.invocationId === 'b')?.status, 'running', 'another invocation remains intact');
});

test('40 lifecycle: out-of-order result/end/start cannot erase authoritative output or attach orphan results to a neighbour', { timeout: 20000 }, async t => {
  const b = await setup(t);
  await b.emit(start('a'), { type: 'tool-end', id: 'a' }, result('a', 'late-recorded-result'), result('orphan', 'never-neighbour'), start('b'));
  const tools = await b.entries();
  const a = tools.find(e => e.summary === 'a');
  assert.equal(a.result, 'late-recorded-result', 'a late authoritative result revises its original entry');
  assert.equal(a.status, 'done');
  const other = tools.find(e => e.summary === 'b');
  assert.equal(other.result, undefined, 'an unknown result is not paired by name or row order');
});

test('40 lifecycle: a result without an authoritative success flag remains unknown', { timeout: 20000 }, async t => {
  const b = await setup(t);
  await b.emit(start('a'), { type: 'tool-result', id: 'a', text: 'transport ended' });
  assert.notEqual((await b.entries())[0].status, 'done', 'missing ok is not proof of success');
});

test('40 isolation: reused numeric entry and invocation ids are distinct across runs of the same role', { timeout: 20000 }, async t => {
  const b = await setup(t, { policy: { maxConcurrent: 2 } });
  const second = await b.bridge.host.start({ ref: `${FEATURE}/30-other-run`, role: 'architect' });
  assert.equal(second.ok, true, JSON.stringify(second));
  await b.emit(start('same'), result('same', 'run-one'));
  b.fake.spawns[1].emit(start('same'));
  b.fake.spawns[1].emit(result('same', 'run-two'));
  await until(async () => (await b.state()).transcripts[second.agent.id]?.entries.some(e => e.result === 'run-two'), { what: 'second run result' });
  const one = (await b.entries())[0], two = (await b.state()).transcripts[second.agent.id].entries.find(e => e.kind === 'tool');
  assert.equal(one.id, two.id, 'the fixture deliberately reuses the numeric entry id');
  assert.deepEqual(one.source, source(b.run.id, one.id));
  assert.deepEqual(two.source, source(second.agent.id, two.id));
  assert.notDeepEqual(one.source, two.source);
  assert.equal(one.result, 'run-one');
  assert.equal(two.result, 'run-two');
});

test('40 disclosure: sanitize before persistence, wire, preview extraction and result clipping, including boundary fragments', { timeout: 20000 }, async t => {
  const b = await setup(t);
  // Put a complete token across both existing clipping boundaries. Checking its full value alone is insufficient.
  const preview = 'p'.repeat(190) + secret + ' preview-safe';
  const output = unsafeText() + '\n' + 'r'.repeat(TRANSCRIPT_RESULT_MAX - unsafeText().length - 10) + secret + ' tail';
  await b.emit(start('safe-call', preview, { input: { command: 'echo visible-input', nested: { note: unsafeText() } } }), result('safe-call', output));
  const state = await b.state();
  const page = await b.history();
  await b.sse.next(f => f.data.type === 'transcript' && f.data.entry?.status === 'done');
  const file = await readFile(path.join(b.fx.root, '.scratch/_run/conversations/architect.jsonl'), 'utf8');
  for (const [where, value] of [['wire', b.sse.frames], ['snapshot', state], ['history', page.body], ['persisted', file]]) noSecrets(value, where);
  const [entry] = await b.entries();
  assert.ok(entry.input !== undefined, 'a safe recorded input is retained, not solved by discarding the field');
  assert.match(JSON.stringify(entry.input), /visible-input/);
  assert.match(JSON.stringify(entry.input), /masked|redacted/i);
  assert.equal(entry.summary.includes(secret.slice(0, 10)), false, 'preview must redact before clipping');
  assert.equal(entry.result.includes(secret.slice(0, 10)), false, 'result must redact before clipping');
  assert.match(entry.result, /clipped|truncated/i, 'bounded output tells the reader what was omitted');
  assert.ok(Buffer.byteLength(entry.result) <= 4300, 'roughly 4 KiB plus truthful notice');
  const [again] = page.body.entries.filter(e => e.kind === 'tool');
  assert.deepEqual(again.source, source(b.run.id, entry.id), 'redacted records keep exact-source lookup');
});

test('40 malformed: unsupported input/result never serialize raw payloads or invent recorded output', { timeout: 20000 }, async t => {
  const b = await setup(t);
  await b.emit(start('a', 'valid', { input: ['RAW-INPUT-40'] }), { type: 'tool-result', id: 'a', text: { raw: 'RAW-RESULT-40' } });
  const entry = (await b.entries())[0];
  assert.equal(JSON.stringify(entry).includes('RAW-INPUT-40'), false);
  assert.equal(JSON.stringify(entry).includes('RAW-RESULT-40'), false);
  assert.notEqual(entry.status, 'done', 'malformed completion is not proven success');
});
