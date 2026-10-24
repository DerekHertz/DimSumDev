import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeBridge, until, send, DISPATCH_REF } from '../agents/host-test-helpers.mjs';
import { makeStateFixture } from '../bridge-fixture.mjs';
import { addProject } from '../projects.mjs';
import { parseCatalog } from '../library/catalog.mjs';
import { createLibrary } from '../library/library.mjs';
import { execFileSync } from 'node:child_process';

test('an authorized moderator can read private records only within its run project', { timeout: 20000 }, async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'meeting-access-'));
  const outside = await makeStateFixture({ git: true });
  execFileSync('git', ['-C', outside.root, 'remote', 'add', 'origin', outside.root]);
  const connection = { name: 'den', title: 'The den', purpose: 'Read authorized meeting context', script: 'apps/bridge/library/servers/den.mjs', credential: 'run', roles: ['chief-of-staff'], tools: { board_comment: 'board' } };
  const b = await makeBridge({ denState: state, library: createLibrary({ catalog: parseCatalog({ connections: [connection] }) }) });
  t.after(async () => { await b.close(); await outside.cleanup(); await rm(state, { recursive: true, force: true }); });
  assert.equal((await addProject(state, { slug: 'acme', path: outside.root, board: { kind: 'markdown' } })).ok, true);
  const own = await b.post('/meetings', { topic: 'Private control project discussion', roles: ['architect'], project: 'den', budget: 4 });
  const other = await b.post('/meetings', { topic: 'Private external project discussion', roles: ['architect'], project: 'acme', budget: 4 });
  assert.equal(own.status, 201, own.text); assert.equal(other.status, 201, other.text);
  const opening = await until(() => b.fake.spawns.find(s => s.args.project.root === b.fx.root), { what: 'opening specialist' });
  opening.emit({ type: 'reply', text: 'Claim: Keep records private' }); opening.emit({ type: 'done', ok: true });
  const run = await until(() => b.fake.spawns.find(s => s.args.role === 'chief-of-staff'), { what: 'authorized moderator' });
  const token = run.args.runCredential?.token;
  assert.ok(token, 'the catalog authorized this run to receive a credential');
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await send(b.bridge, { path: `/run/meetings/${own.body.meeting.id}`, headers })).status, 200);
  const denied = await send(b.bridge, { path: `/run/meetings/${other.body.meeting.id}`, headers });
  assert.equal(denied.status, 404);
  assert.equal(JSON.stringify(denied.body).includes('Private external'), false);
});

test('the live meeting is named in dispatch/delivery refusals, then a full pause releases its hold', { timeout: 20000 }, async t => {
  const b = await makeBridge(); t.after(() => b.close());
  const res = await b.post('/meetings', { ref: DISPATCH_REF, topic: 'Review', roles: ['architect'], budget: 4 });
  assert.equal(res.status, 201, res.text);
  const id = res.body.meeting.id;
  const run = await until(() => b.fake.spawns[0], { what: 'held meeting' });
  assert.equal((await b.state()).capacity.room, 1, 'a meeting hold does not consume an additional worker slot');
  for (const route of ['/agents', '/deliveries']) {
    const refused = await b.post(route, { ref: DISPATCH_REF, role: 'developer' });
    assert.equal(refused.status, 409, refused.text); assert.match(refused.body.error, new RegExp(id));
  }
  await b.post(`/meetings/${id}/stop`);
  run.emit({ type: 'reply', text: 'Claim: Review complete' }); run.emit({ type: 'done', ok: true });
  await until(async () => (await b.state()).meetings[0].state === 'paused' && !(await b.state()).tickets.find(t => t.ref === DISPATCH_REF)?.holder, { what: 'fully paused hold released' });
  assert.equal((await b.post('/agents', { ref: DISPATCH_REF, role: 'architect' })).status, 201);
  assert.equal((await b.post(`/meetings/${id}/resume`)).status, 409, 'a different run now owns the task');
});
