import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeBridge, until } from './host-test-helpers.mjs';
let t;
afterEach(async () => { await t?.close(); t = null; });
const request = (more = {}) => ({ issue: 'formatter', kind: 'child', role: 'developer', task: 'Check formatter', reason: 'Independent targeted check', files: ['sample.txt'], constraints: ['No dependencies'], acceptance: ['Check passes'], ...more });
async function manager() {
  t = await makeBridge();
  const res = await t.post('/tasks', { role: 'developer', text: 'Coordinate checks', orchestration: { kind: 'manager', task: 'Coordinate checks', reason: 'Separate changes', files: ['sample.txt'], constraints: ['No dependencies'], acceptance: ['Checks pass'] } });
  assert.equal(res.status, 201, res.text);
  return { agent: res.body.agent, delegate: t.fake.spawns[0].args.delegate };
}

test('autonomous repair stops after two failed children and asks for a root-cause report', async () => {
  const { delegate } = await manager();
  for (let n = 1; n <= 2; n++) {
    const result = delegate(request());
    const child = await until(() => t.fake.spawns[n], { what: 'delegated child' });
    child.emit({ type: 'reply', text: 'Root cause still unresolved; targeted check failed.' });
    child.emit({ type: 'done', ok: false });
    const returned = await result;
    assert.equal(returned.ok, false);
    assert.equal(returned.failures, n);
  }
  const stopped = await delegate(request());
  assert.equal(stopped.status, 409);
  assert.match(stopped.error, /root cause, remaining uncertainty and next options/);
  assert.equal(t.fake.spawns.length, 3, 'no third repair process');
});

test('delegation uses global capacity and parent cancellation settles its waiting tool', async () => {
  const { agent, delegate } = await manager();
  const waiting = delegate(request());
  await until(() => t.fake.spawns[1], { what: 'delegated child' });
  const full = await delegate(request({ issue: 'different', task: 'Another check' }));
  assert.equal(full.status, 429);
  assert.equal((await t.post(`/agents/${agent.id}/stop`)).status, 202);
  assert.equal((await waiting).state, 'terminated');
  assert.equal(t.fake.peakLive, 2);
});

test('leaf, scope, settings and authority violations launch nothing; completed work is reused', async () => {
  const { delegate } = await manager();
  for (const input of [request({ files: ['outside.txt'] }), request({ kind: 'manager' }), request({ execution: { speed: 'fast' } }), request({ runtime: 'codex' })]) {
    assert.equal((await delegate(input)).ok, false);
  }
  assert.equal(t.fake.spawns.length, 1);
  const pending = delegate(request());
  const child = await until(() => t.fake.spawns[1], { what: 'delegated child' });
  assert.equal(child.args.delegate, undefined, 'leaf gets no delegation capability');
  assert.equal((await delegate(request({ parent: child.args.runId }))).ok, false, 'caller identity cannot be forged');
  child.emit({ type: 'reply', text: 'Targeted checks passed.' });
  child.emit({ type: 'done', ok: true });
  assert.equal((await pending).ok, true);
  assert.match((await delegate(request())).error, /complete; reuse/);
  assert.equal(t.fake.spawns.length, 2);
});

test('concurrent delegations of one issue share one reservation after asynchronous scope validation', async () => {
  t = await makeBridge();
  const lead = await t.post('/tasks', { role: 'chief-of-staff', text: 'Coordinate two checks' });
  assert.equal(lead.status, 201, lead.text);
  const delegate = t.fake.spawns[0].args.delegate;
  const pending = [delegate(request({ kind: 'implementer', files: ['a.txt'] })), delegate(request({ kind: 'implementer', files: ['b.txt'] }))];
  const child = await until(() => t.fake.spawns[1], { what: 'one reserved child' });
  let timer;
  const refused = await Promise.race([...pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
  clearTimeout(timer);
  assert.equal(refused?.status, 409, 'the duplicate is refused before the first child finishes');
  child.emit({ type: 'done', ok: false });
  const results = await Promise.all(pending);
  assert.equal(t.fake.spawns.length, 2, 'same issue cannot launch a second child even with a free worker slot');
  assert.equal(results.filter(r => r.status === 409).length, 1);
  assert.equal(results.find(r => r.state)?.failures, 1);
});
