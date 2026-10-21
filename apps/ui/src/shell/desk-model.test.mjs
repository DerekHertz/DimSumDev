import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deskActivity, deskResidents } from './desk-model.mjs';

test('a quiet garden keeps all thirty-two permanent residents without invented activity', () => {
  const residents = deskResidents(null);
  assert.equal(residents.length, 32);
  assert.equal(new Set(residents.map(row => row.id)).size, 32);
  assert.ok(residents.every(row => row.state === 'resident' && row.ref === null));
  assert.deepEqual(deskActivity(null), { working: 0, waiting: 0, blocked: 0, resting: 32, visitors: 0 });
});

test('concurrent work gets separate visitors and preserves the exact ticket selection', () => {
  const snapshot = { agents: [
    { id: 'dev-a', role: 'developer', ref: 'feature/01', state: 'working' },
    { id: 'dev-b', role: 'developer', ref: 'feature/02', state: 'waiting_on_user' },
    { id: 'old', role: 'qa', ref: 'feature/03', state: 'done' },
  ] };
  const developers = deskResidents(snapshot).filter(row => row.role === 'developer' && row.runtime === 'claude');
  assert.deepEqual(developers.map(({ id, ref, state, visitor }) => ({ id, ref, state, visitor })), [
    { id: 'developer', ref: 'feature/01', state: 'working', visitor: false },
    { id: 'developer#feature/02', ref: 'feature/02', state: 'needs-you', visitor: true },
  ]);
  assert.deepEqual(deskActivity(snapshot), { working: 1, waiting: 1, blocked: 0, resting: 31, visitors: 1 });
});

test('profiles preserve live task identity without treating placement tool data as correlated activity', () => {
  const snapshot = { tickets: [
    { ref: 'feature/01', title: 'Build the garden', holder: { role: 'developer' } },
    { ref: 'feature/02', title: 'Repair the bridge', holder: { role: 'developer' } },
  ], placements: [
    { ref: 'feature/01', role: 'developer', state:'working', lastEventAt: '2026-10-16T12:00:00Z', tool: { name: 'Read', summary: 'garden model' } },
    { ref: 'feature/02', role: 'developer', state:'working', lastEventAt: '2026-10-16T12:00:00Z' },
  ] };
  const rows = deskResidents(snapshot, { now: Date.parse('2026-10-16T12:00:01Z') });
  assert.equal(rows.find(row => row.id === 'developer').task, 'feature/01 · Build the garden');
  assert.equal(rows.find(row => row.id === 'developer').bubble, '');
  assert.equal(rows.find(row => row.id === 'developer#feature/02').task, 'feature/02 · Repair the bridge');
  const quiet = deskResidents(null).find(row => row.role === 'developer');
  assert.equal(quiet.task, undefined);
  assert.equal(quiet.bubble, undefined);
});

test('36 Team profiles show exact unavailable visitors and unbound meeting copies without changing run state',()=>{
 const snapshot={agents:[{id:'one',role:'developer',ref:'work/one',state:'working'},{id:'two',role:'developer',ref:'work/two',state:'working'}]};
 const rows=deskResidents(snapshot,{scenePresentations:[{id:'developer#work/two',role:'developer',runtime:'claude',ref:'work/two',agentId:'two',presentation:'Scene place unavailable'},{id:'meeting:developer',role:'developer',runtime:'claude',ref:null,guest:true,presentation:'Scene place unavailable'}]});
 assert.deepEqual(rows.find(r=>r.id==='developer#work/two').sceneNotes,['Scene place unavailable']);
 assert.deepEqual(rows.find(r=>r.id==='developer').sceneNotes,['Meeting visitor · Scene place unavailable']);
 assert.equal(rows.find(r=>r.id==='developer#work/two').state,'working');
 const stale=deskResidents(snapshot,{scenePresentations:[{id:'developer#work/two',role:'developer',runtime:'claude',ref:'work/other',agentId:'old',presentation:'Scene place unavailable'}]});
 assert.deepEqual(stale.find(r=>r.id==='developer#work/two').sceneNotes,[],'old actor presentation never attaches to a different run');
});
