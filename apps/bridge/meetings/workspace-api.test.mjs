import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeBridge, until, send, DISPATCH_REF } from '../agents/host-test-helpers.mjs';

test('real host runs a standalone private meeting, attributes specialist context, and pauses without cancelling', { timeout: 20000 }, async t => {
  const b = await makeBridge(); t.after(() => b.close());
  const start = await b.post('/meetings', { topic: 'Compare recovery approaches', project: 'den', roles: ['architect'], moderator: 'bao', budget: 3 });
  assert.equal(start.status, 201, start.text);
  const m = start.body.meeting;
  assert.equal(m.ref, null);
  const spawn = await until(() => b.fake.spawns[0], { what: 'specialist run' });
  assert.equal(spawn.args.effort, 'medium');
  assert.match(spawn.args.prompt, /standalone/i);
  assert.equal((await b.post(`/meetings/${m.id}/stop`, {})).body.meeting.state, 'pausing');
  spawn.emit({ type: 'reply', text: 'Claim: Prefer one journal\nEvidence: recovery.mjs\nConfidence: unsure' });
  spawn.emit({ type: 'done', ok: true, costUsd: 0.15 });
  await until(async () => (await b.state()).meetings[0].state === 'paused', { what: 'paused after current response' });
  assert.equal(JSON.stringify(await b.state()).includes('Prefer one journal'), false, 'public scene metadata must not contain private discussion');
  const saved = await b.post(`/meetings/${m.id}/preview`, { tickets: [] });
  assert.equal(saved.status, 400);
  const record = await b.post(`/meetings/${m.id}/resume`, {});
  assert.equal(record.status, 202, record.text);
  const moderator = await until(() => b.fake.spawns[1], { what: 'moderator run' });
  assert.equal(moderator.args.role, 'chief-of-staff');
  assert.match(await readFile(path.join(moderator.args.cwd, '.den/meeting.md'), 'utf8'), /Prefer one journal/);
  moderator.emit({ type: 'reply', text: JSON.stringify({ action: 'settled', summary: 'One journal', followUps: [] }) });
  moderator.emit({ type: 'done', ok: true });
  await until(async () => (await b.state()).meetings[0].state === 'ready-for-review', { what: 'review ready' });
  assert.equal(b.fake.spawns.length, 2);
});

test('task-linked meetings hold their task until review/end and private reads require a user session', { timeout: 20000 }, async t => {
  const b = await makeBridge(); t.after(() => b.close());
  const res = await b.post('/meetings', { ref: DISPATCH_REF, topic: 'Review task risk', roles: ['architect'], budget: 3 });
  assert.equal(res.status, 201, res.text);
  const m = res.body.meeting;
  const held = (await b.state()).tickets.find(ticket => ticket.ref === DISPATCH_REF);
  assert.ok(held.holder, 'meeting holds the task between runs');
  assert.equal((await b.post('/agents', { ref: DISPATCH_REF, role: 'developer' })).status, 409);
  assert.equal((await send(b.bridge, { path: `/meetings/${m.id}` })).status, 401);
  assert.equal((await send(b.bridge, { path: '/meetings' })).status, 401);
  assert.equal((await b.post(`/meetings/${m.id}/close`)).status, 202);
  await until(async () => !(await b.state()).tickets.find(ticket => ticket.ref === DISPATCH_REF)?.holder, { what: 'meeting task released' });
});

test('setup rejects unknown project and secret-bearing input before starting any work', async t => {
  const b = await makeBridge(); t.after(() => b.close());
  const refused = await b.post('/meetings', { project: '../outside', topic: 'Investigate', roles: ['architect'] });
  assert.equal(refused.status, 400);
  for (const roles of [[], ['architect', 'architect'], ['unknown']]) assert.equal((await b.post('/meetings', { topic: 'Investigate', roles })).status, 400);
  assert.equal((await b.post('/meetings', { topic: 'ghp_' + 'X'.repeat(36), roles: ['architect'] })).status, 400);
  assert.equal(b.fake.spawns.length, 0);
});
