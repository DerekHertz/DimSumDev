import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBridge, until, send, openSse } from '../agents/host-test-helpers.mjs';
import { createApprovalReview } from '../../ui/src/overlay/approval-review.mjs';

const PRIVATE = 'PRIVATE-MEETING-CANARY';
const absent = value => assert.equal(JSON.stringify(value).includes(PRIVATE), false, 'public response contains private meeting context');

test('meeting permission context stays behind authenticated detail reads through its decision', async t => {
  const b = await makeBridge();
  t.after(() => b.close());
  const stream = openSse(b.bridge);
  await stream.opened;
  t.after(() => stream.close());
  const started = await b.post('/meetings', { topic: 'Private review', roles: ['architect'], budget: 3 });
  assert.equal(started.status, 201);
  const run = await until(() => b.fake.spawns[0]);
  run.emit({ type: 'text', text: `${PRIVATE} discussion` });
  run.emit({ type: 'permission-request', requestId: 'private-read', tool: 'Bash', input: { command: `rg ${PRIVATE} apps`, description: `${PRIVATE} intent` } });
  const pending = await until(async () => (await b.state()).approvals?.find(a => a.state === 'pending'));
  assert.equal(pending.summary, 'Private meeting permission request');
  assert.equal(pending.state, 'pending');
  absent(await b.state());
  await stream.next(f => f.event === 'change' && f.data.approval?.id === pending.id);
  absent(stream.frames);
  assert.equal((await send(b.bridge, { path: `/approvals/${pending.id}` })).status, 401);
  const detail = await send(b.bridge, { path: `/approvals/${pending.id}`, headers: b.headers });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.says, `${PRIVATE} discussion`);
  assert.equal(detail.body.intent, `${PRIVATE} intent`);
  assert.equal(detail.body.input.command, `rg ${PRIVATE} apps`);
  const review = createApprovalReview({ client: {
    getApproval: async id => (await send(b.bridge, { path: `/approvals/${id}`, headers: b.headers })).body,
  } });
  assert.equal(review.open({ approval: pending, actions: { E: { enabled: true }, Q: { enabled: true } } }).opened, true);
  await until(() => review.getState().phase === 'ready');
  assert.equal(review.getState().heading, 'Run Bash');
  assert.equal(review.getState().allowEnabled, true);
  const decided = await b.post(`/approvals/${pending.id}`, { decision: 'allow', note: `${PRIVATE} answer` });
  assert.equal(decided.status, 200);
  assert.equal(run.decisions.at(-1).allow, true);
  await stream.next(f => f.event === 'change' && f.data.approval?.id === pending.id && f.data.approval.state === 'allowed');
  absent(await b.state());
  absent(stream.frames);
  const late = openSse(b.bridge);
  await late.opened;
  t.after(() => late.close());
  absent((await late.next(f => f.event === 'snapshot')).data);
});

test('private meeting questions stay readable to the user and hidden publicly after expiry', async t => {
  const b = await makeBridge();
  t.after(() => b.close());
  const stream = openSse(b.bridge);
  await stream.opened;
  t.after(() => stream.close());
  const started = await b.post('/meetings', { topic: 'Private questions', roles: ['architect'], budget: 3 });
  const run = await until(() => b.fake.spawns[0]);
  const questions = [{ question: `${PRIVATE} question`, header: PRIVATE, options: [{ label: PRIVATE, description: `${PRIVATE} option` }], multiSelect: false }];
  run.emit({ type: 'permission-request', requestId: 'private-question', tool: 'AskUserQuestion', input: { questions } });
  const pending = await until(async () => (await b.state()).approvals?.find(a => a.state === 'pending'));
  const detail = await send(b.bridge, { path: `/approvals/${pending.id}`, headers: b.headers });
  assert.deepEqual(detail.body.questions, questions);
  absent(await b.state());
  assert.equal((await b.post(`/meetings/${started.body.meeting.id}/close`)).status, 202);
  await stream.next(f => f.event === 'change' && f.data.approval?.id === pending.id && f.data.approval.state === 'expired');
  absent(stream.frames);
  absent(await b.state());
});

test('meeting wall targets are private in approvals and agent state frames', async t => {
  const b = await makeBridge();
  t.after(() => b.close());
  const stream = openSse(b.bridge);
  await stream.opened;
  t.after(() => stream.close());
  await b.post('/meetings', { topic: 'Private wall targets', roles: ['architect'], budget: 3 });
  const run = await until(() => b.fake.spawns[0]);
  for (let i = 0; i < 3; i++) {
    run.emit({ type: 'tool-start', id: `wall-${i}`, name: 'Bash', summary: PRIVATE });
    run.emit({ type: 'tool-result', id: `wall-${i}`, text: `/tmp/${PRIVATE}-${i}: Read-only file system`, ok: false });
  }
  const pending = await until(async () => (await b.state()).approvals?.find(a => a.state === 'pending'));
  const detail = await send(b.bridge, { path: `/approvals/${pending.id}`, headers: b.headers });
  assert.deepEqual(detail.body.wall, { kind: 'write', targets: [0, 1, 2].map(i => `/tmp/${PRIVATE}-${i}`) });
  await stream.next(f => f.event === 'change' && f.data.approval?.id === pending.id);
  absent(await b.state());
  absent(stream.frames);
  assert.equal((await b.post(`/approvals/${pending.id}`, { decision: 'deny' })).status, 200);
  await stream.next(f => f.event === 'change' && f.data.approval?.id === pending.id && f.data.approval.state === 'denied');
  absent(await b.state());
  absent(stream.frames);
});

test('authenticated private question review requires and sends distinct answers', async t => {
  const b = await makeBridge();
  t.after(() => b.close());
  await b.post('/meetings', { topic: 'Private questions', roles: ['architect'], budget: 3 });
  const run = await until(() => b.fake.spawns[0]);
  const questions = [
    { question: `${PRIVATE} path?`, header: 'Path', options: [{ label: 'A' }, { label: 'B' }] },
    { question: `${PRIVATE} checks?`, header: 'Checks', options: [{ label: 'Unit' }, { label: 'Browser' }], multiSelect: true },
    { question: `${PRIVATE} alternative?`, header: 'Alternative', options: [{ label: 'Default' }] },
  ];
  run.emit({ type: 'permission-request', requestId: 'distinct-questions', tool: 'AskUserQuestion', input: { questions } });
  const pending = await until(async () => (await b.state()).approvals?.find(a => a.state === 'pending'));
  absent(pending);
  const sent = [];
  const review = createApprovalReview({ client: {
    getApproval: async id => (await send(b.bridge, { path: `/approvals/${id}`, headers: b.headers })).body,
    decide: async (id, body) => {
      sent.push(body);
      const response = await b.post(`/approvals/${id}`, body);
      assert.equal(response.status, 200, response.text);
      return response.body;
    },
  } });
  review.open({ approval: pending, actions: { E: { enabled: true }, Q: { enabled: true } } });
  await until(() => review.getState().phase === 'ready');
  assert.equal(review.getState().questions?.length, 3);
  assert.equal(review.getState().allowEnabled, false);
  await review.press('allow');
  assert.equal(sent.length, 0);
  review.pickAnswer(0, 'B');
  review.pickAnswer(1, 'Unit');
  review.pickAnswer(1, 'Browser');
  review.pickAnswer(2, null);
  assert.equal(review.getState().allowEnabled, false);
  review.writeAnswer(2, 'Another approach');
  assert.equal(review.getState().allowEnabled, true);
  await review.press('allow');
  assert.deepEqual(sent, [{ decision: 'allow', answers: ['B', ['Unit', 'Browser'], 'Another approach'] }]);
  const detail = await send(b.bridge, { path: `/approvals/${pending.id}`, headers: b.headers });
  assert.equal(detail.body.state, 'allowed');
  assert.equal(detail.body.note, 'Path: B · Checks: Unit, Browser · Alternative: Another approach');
  absent(await b.state());
});
