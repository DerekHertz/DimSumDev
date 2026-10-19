import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deskActivity, deskResidents } from './desk-model.mjs';

test('a quiet garden keeps all twenty-five permanent residents without invented activity', () => {
  const residents = deskResidents(null);
  assert.equal(residents.length, 25);
  assert.equal(new Set(residents.map(row => row.id)).size, 25);
  assert.ok(residents.every(row => row.state === 'resident' && row.ref === null));
  assert.deepEqual(deskActivity(null), { working: 0, waiting: 0, blocked: 0, resting: 25, visitors: 0 });
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
  assert.deepEqual(deskActivity(snapshot), { working: 1, waiting: 1, blocked: 0, resting: 24, visitors: 1 });
});

test('profiles preserve live task and tool activity for the primary resident and exact visitor', () => {
  const snapshot = { tickets: [
    { ref: 'feature/01', title: 'Build the garden', holder: { role: 'developer' } },
    { ref: 'feature/02', title: 'Repair the bridge', holder: { role: 'developer' } },
  ], cells: [
    { ref: 'feature/01', cellType: 'developer', state:'working', lastEventAt: '2026-10-16T12:00:00Z', tool: { name: 'Read', summary: 'garden model' } },
    { ref: 'feature/02', cellType: 'developer', state:'working', lastEventAt: '2026-10-16T12:00:00Z' },
  ] };
  const rows = deskResidents(snapshot, { now: Date.parse('2026-10-16T12:00:01Z') });
  assert.equal(rows.find(row => row.id === 'developer').task, 'feature/01 · Build the garden');
  assert.equal(rows.find(row => row.id === 'developer').bubble, 'Read: garden model');
  assert.equal(rows.find(row => row.id === 'developer#feature/02').task, 'feature/02 · Repair the bridge');
  const quiet = deskResidents(null).find(row => row.role === 'developer');
  assert.equal(quiet.task, undefined);
  assert.equal(quiet.bubble, undefined);
});
