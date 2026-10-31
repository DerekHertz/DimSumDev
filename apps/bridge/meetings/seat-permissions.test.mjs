// den-meetings/01: a seat's writes are denied at once, and any request it still raises shows in that meeting's chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBridge, until, send } from '../agents/host-test-helpers.mjs';

const SECRET_WORDS = 'curl-the-moon';
const record = async (b, id) => (await send(b.bridge, { path: `/meetings/${id}`, headers: b.headers })).body;
const begin = async (t, topic) => {
  const b = await makeBridge();
  t.after(() => b.close());
  const started = await b.post('/meetings', { topic, roles: ['architect'], budget: 3 });
  assert.equal(started.status, 201);
  const run = await until(() => b.fake.spawns[0]);
  return { b, run, id: started.body.meeting.id };
};

test('a meeting seat is started read-only', async t => {
  const { run } = await begin(t, 'Read-only seat');
  assert.equal(run.args.readOnly, true);
  assert.equal(typeof run.args.root, 'string');
});

for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
  test(`a seat's ${tool} is denied at once with a reason and never held`, async t => {
    const { b, run, id } = await begin(t, `Deny ${tool}`);
    run.emit({ type: 'permission-request', requestId: `w-${tool}`, tool, input: { file_path: '/x/y.md', content: 'z' } });
    const decision = await until(() => run.decisions.find(d => d.requestId === `w-${tool}`));
    assert.equal(decision.allow, false);
    assert.match(decision.reason, /read-only/i);
    assert.deepEqual(((await b.state()).approvals ?? []).filter(a => a.state === 'pending'), []);
    assert.equal((await record(b, id)).events.some(e => e.kind === 'permission-request'), false);
  });
}

test('a request a seat still raises appears in the meeting chat, and answering it resumes the seat', async t => {
  const { b, run, id } = await begin(t, 'Ask in chat');
  run.emit({ type: 'permission-request', requestId: 'fetch-1', tool: 'WebFetch', input: { url: 'https://example.org/a', prompt: SECRET_WORDS } });
  const pending = await until(async () => (await b.state()).approvals?.find(a => a.state === 'pending'));
  assert.equal(pending.summary, 'Private meeting permission request');
  const card = await until(async () => (await record(b, id)).events.find(e => e.kind === 'permission-request'));
  assert.equal(card.approvalId, pending.id);
  assert.equal(card.actor, 'architect');
  assert.equal(card.tool, 'WebFetch');
  assert.match(card.summary, /example\.org/);
  assert.equal(card.expiresAt, pending.expiresAt);
  assert.equal(JSON.stringify(await b.state()).includes('example.org'), false);
  assert.equal((await send(b.bridge, { path: `/approvals/${card.approvalId}`, headers: b.headers })).status, 200);
  assert.equal((await b.post(`/approvals/${card.approvalId}`, { decision: 'allow' })).status, 200);
  assert.equal(run.decisions.find(d => d.requestId === 'fetch-1').allow, true);
  const settled = await until(async () => (await record(b, id)).events.find(e => e.kind === 'permission-settled'));
  assert.deepEqual([settled.approvalId, settled.state], [card.approvalId, 'allowed']);
});

test('denying a request in the chat closes its card and refuses the seat', async t => {
  const { b, run, id } = await begin(t, 'Deny in chat');
  run.emit({ type: 'permission-request', requestId: 'fetch-2', tool: 'WebFetch', input: { url: 'https://example.org/b' } });
  const card = await until(async () => (await record(b, id)).events.find(e => e.kind === 'permission-request'));
  await send(b.bridge, { path: `/approvals/${card.approvalId}`, headers: b.headers });
  assert.equal((await b.post(`/approvals/${card.approvalId}`, { decision: 'deny' })).status, 200);
  const settled = await until(async () => (await record(b, id)).events.find(e => e.kind === 'permission-settled'));
  assert.equal(settled.state, 'denied');
  assert.equal(run.decisions.find(d => d.requestId === 'fetch-2').allow, false);
});
