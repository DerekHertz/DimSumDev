import test from 'node:test';
import assert from 'node:assert/strict';
import { meetingPillLabel, recentActivity } from './meeting-model.mjs';

test('the meeting pill names every modern waiting and resting state truthfully', () => {
  const labels = { 'waiting-decision': 'Waiting on your decision', 'waiting-budget': 'Waiting for budget approval', pausing: 'Pausing', paused: 'Paused', 'ready-for-review': 'Ready for review', ended: 'Ended' };
  for (const [state, text] of Object.entries(labels)) assert.match(meetingPillLabel({ schema: 2, state, title: 'Private meeting' }), new RegExp(text));
});

test('recent activity is ordered, linked and bounded without copying private discussion', () => {
  const snapshot = { meetings: [{ id: 'm-one', activity: [{ id: 'e-one', kind: 'message', actor: 'architect', round: 1, at: '2026-10-23T10:00:00Z', text: 'PRIVATE CONTENT MUST NOT APPEAR' }, { id: 'e-two', kind: 'status', actor: 'jiao', state: 'waiting-decision', at: '2026-10-23T10:01:00Z' }] }], agents: [{ id: 'c-one', role: 'developer', state: 'working', lastEventAt: '2026-10-23T10:02:00Z' }], deliveries: [{ id: 'd-one', ref: 'den/08-task', state: 'paused', updatedAt: '2026-10-23T10:03:00Z' }] };
  const rows = recentActivity(snapshot, 3);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.kind), ['delivery', 'agent', 'meeting']);
  assert.equal(rows[2].target, 'm-one');
  assert.match(rows[2].text, /Waiting on your decision/);
  assert.equal(JSON.stringify(rows).includes('PRIVATE CONTENT'), false);
});
