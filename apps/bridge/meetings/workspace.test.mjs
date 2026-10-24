import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMeetings } from './runner.mjs';
import { createMeetingLog } from './log.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meeting-workspace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const starts = [], tickets = [];
  const host = { start: async body => { starts.push(body); return { ok: true, agent: { id: `c-${String(starts.length).padStart(16, '0')}` } }; }, stop: async () => {} };
  const options = { host, log: createMeetingLog(dir), readTicket: async () => ({ title: 'Task', owner: 'jiao', project: 'den' }), proposeTicket: async body => { tickets.push(body); return { ref: 'den/01-follow-up' }; } };
  const api = createMeetings(options);
  await api.ready;
  const flush = async () => { for (let n = 0; n < 10; n++) await new Promise(r => setTimeout(r, 5)); };
  const finish = async (text, extra = {}) => { await flush(); const m = api.snapshot().at(-1); await api.onEnd({ agentId: m.live.runId, state: 'done', report: text, ...extra }); await flush(); };
  return { api, options, starts, tickets, finish, flush };
}

test('standalone setup persists Jiao, project and permanent private chronological record without a discussion ticket', async t => {
  const f = await fixture(t);
  const started = await f.api.start({ topic: 'Consider storage', project: 'den', moderator: 'jiao', roles: ['architect'], depth: 'dig-in', budget: 2 });
  assert.equal(started.ok, true, started.error);
  await f.flush();
  assert.equal(f.starts[0].runtime, 'codex');
  assert.equal(f.starts[0].project, 'den');
  await f.finish('Claim: Keep it private.\nConfidence: fairly sure', { costUsd: 0.12 });
  await f.finish('SETTLED: Keep the record private.');
  const record = await f.api.read(started.meeting.id);
  assert.equal(record.meeting.moderator, 'jiao');
  assert.equal(record.meeting.ref, null);
  assert.equal(record.events.find(e => e.kind === 'message').actor, 'architect');
  assert.equal(record.events.find(e => e.kind === 'message').runId, 'c-0000000000000001');
  const restarted = createMeetings(f.options);
  await restarted.ready;
  const replay = await restarted.read(started.meeting.id);
  assert.equal(replay.meeting.project, 'den');
  assert.deepEqual(replay.events, record.events);
  assert.equal(f.tickets.length, 0);
});

test('redirects and linked responses apply after the current run; pausing counts its final cost', async t => {
  const f = await fixture(t);
  const { meeting: m } = await f.api.start({ topic: 'Choose storage', roles: ['architect', 'qa'], budget: 5 });
  await f.flush();
  await f.api.ask(m.id, { text: 'Prioritize recovery' });
  assert.equal(f.starts.length, 1);
  await f.api.stop(m.id);
  assert.equal(f.api.snapshot()[0].state, 'pausing');
  await f.finish('Claim: One journal', { costUsd: 0.25 });
  assert.equal(f.api.snapshot()[0].state, 'paused');
  assert.equal(f.api.snapshot()[0].spent, 0.25);
  assert.equal(f.starts.length, 1);
  await f.api.resume(m.id);
  await f.flush();
  assert.match(f.starts[1].meeting.file, /Prioritize recovery/);
  const source = (await f.api.read(m.id)).events.find(e => e.kind === 'message' && e.actor === 'architect');
  await f.api.ask(m.id, { text: 'Test this claim', reask: 'qa', sourceId: source.id });
  await f.finish('Claim: Opening QA take');
  assert.equal(f.starts[2].role, 'qa');
  assert.match(f.starts[2].meeting.file, /One journal/);
  await f.finish('Claim: Recovery verified');
  const reply = (await f.api.read(m.id)).events.find(e => e.text === 'Claim: Recovery verified');
  assert.equal(reply.sourceId, source.id);
  assert.equal(reply.actor, 'qa');
});

test('budget approval precedes work, including retry and escalation; missing input blocks a decision', async t => {
  const f = await fixture(t);
  const { meeting: m } = await f.api.start({ topic: 'Choose storage', roles: ['qa'], budget: 0 });
  await f.flush();
  assert.equal(f.starts.length, 0);
  assert.equal(f.api.snapshot()[0].state, 'waiting-budget');
  await f.api.approveBudget(m.id, { budget: 5 });
  await f.flush();
  await f.api.onEnd({ agentId: f.api.snapshot()[0].live.runId, state: 'failed' });
  await f.flush();
  await f.finish(JSON.stringify({ action: 'decision', question: 'Accept?', options: [{ key: 'A', title: 'Yes', tradeoff: 'Risk' }, { key: 'B', title: 'No', tradeoff: 'Delay' }], recommended: 'A', required: ['qa'] }));
  assert.equal(f.api.snapshot()[0].state, 'paused');
  assert.equal((await f.api.decide(m.id, { option: 'A' })).ok, false);
  await f.api.retry(m.id, { role: 'qa' });
  await f.flush();
  assert.equal(f.starts.at(-1).role, 'qa');
});

test('decisions resume without tickets; only edited, explicitly approved previews create follow-ups, never runs', async t => {
  const f = await fixture(t);
  const { meeting: m } = await f.api.start({ topic: 'Choose storage', roles: ['architect'], budget: 10 });
  await f.finish('Claim: One journal');
  const sourceId = (await f.api.read(m.id)).events.find(e => e.actor === 'architect').id;
  await f.finish(JSON.stringify({ action: 'decision', question: 'Which?', options: [{ key: 'A', title: 'One', tradeoff: 'Growth' }, { key: 'B', title: 'Many', tradeoff: 'Discovery' }], recommended: 'A', sourceIds: [sourceId], required: ['architect'] }));
  assert.equal(f.api.snapshot()[0].state, 'waiting-decision');
  await f.api.decide(m.id, { option: 'A' });
  await f.flush();
  assert.equal(f.api.snapshot()[0].state, 'running');
  assert.equal(f.tickets.length, 0);
  await f.finish(JSON.stringify({ action: 'settled', summary: 'Use one journal', followUps: [{ title: 'Build journal', text: 'PRIVATE MODEL DRAFT' }] }));
  const before = f.starts.length;
  const preview = await f.api.preview(m.id, { tickets: [{ title: 'Journal', text: 'Only reviewed text', includeRecord: false }] });
  assert.equal(preview.tickets[0].text, 'Only reviewed text');
  assert.equal(f.tickets.length, 0);
  assert.equal((await f.api.publish(m.id, { previewId: preview.previewId })).ok, false);
  const published = await f.api.publish(m.id, { previewId: preview.previewId, approved: true });
  assert.equal(published.ok, true);
  assert.equal(f.tickets[0].text, 'Only reviewed text');
  assert.equal(f.starts.length, before);
  await f.api.close(m.id);
  assert.equal((await f.api.resume(m.id)).ok, false);
  const continuation = await f.api.continueMeeting(m.id);
  assert.equal(continuation.setup.continuedFrom, m.id);
  assert.equal(f.starts.length, before);
});

test('moderator escalations request budget before High work; new participants get context and removals apply next', async t => {
  const f = await fixture(t);
  const { meeting: m } = await f.api.start({ topic: 'Storage', roles: ['architect'], budget: 0.8 });
  await f.finish('Claim: One journal');
  const sourceId = (await f.api.read(m.id)).events.find(e => e.actor === 'architect' && e.kind === 'message').id;
  await f.finish(JSON.stringify({ action: 'follow-up', requests: [{ role: 'architect', sourceId, instruction: 'Resolve the disputed recovery risk', effort: 'high', reason: 'Recovery durability is consequential' }] }));
  assert.equal(f.starts.length, 2, 'no high-effort work before budget approval');
  assert.equal(f.api.snapshot()[0].state, 'waiting-budget');
  assert.match((await f.api.read(m.id)).events.find(e => e.kind === 'effort').text, /consequential/);
  await f.api.approveBudget(m.id, { budget: 5 }); await f.flush();
  assert.equal(f.starts[2].meeting.effort, 'high');
  await f.api.participants(m.id, { roles: ['qa'] });
  assert.equal(f.starts.length, 3);
  await f.finish('Claim: Dispute resolved');
  assert.equal(f.starts[3].role, 'qa');
  assert.match(f.starts[3].meeting.file, /One journal/);
  assert.match(f.starts[3].meeting.file, /Dispute resolved/);
  assert.equal((await f.api.read(m.id)).meeting.seats.find(s => s.role === 'architect').active, false);
});

test('ended in-flight responses retain attribution and cost without resuming; continuation carries decisions and open questions', async t => {
  const f = await fixture(t);
  const { meeting: m } = await f.api.start({ topic: 'Storage', roles: ['architect'], budget: 4 });
  await f.flush();
  await f.api.close(m.id);
  await f.finish('Partial final contribution', { costUsd: 0.3 });
  const record = await f.api.read(m.id);
  assert.equal(record.meeting.state, 'ended');
  assert.equal(record.meeting.spent, 0.3);
  assert.equal(record.events.find(e => e.text === 'Partial final contribution').actor, 'architect');
  assert.equal(f.starts.length, 1);
  const setup = (await f.api.continueMeeting(m.id)).setup;
  const next = await f.api.start({ ...setup, budget: 1, moderator: 'jiao', roles: ['qa'] });
  assert.equal(next.meeting.continuedFrom, m.id);
  assert.notEqual(next.meeting.id, m.id);
  assert.equal(next.meeting.moderator, 'jiao');
});

test('suggestions do not block the approved task meeting; replaced specialists remain in permanent replay', async t => {
  const f = await fixture(t);
  const suggestion = await f.api.start({ ref: 'den/08-task', topic: 'Storage', roles: ['architect'], budget: 4, suggestOnly: true });
  await f.finish(JSON.stringify({ action: 'suggestions', specialists: [{ role: 'qa', reason: 'Verify recovery' }] }));
  assert.equal((await f.api.read(suggestion.meeting.id)).meeting.suggestions[0].reason, 'Verify recovery');
  const actual = await f.api.start({ ref: 'den/08-task', topic: 'Storage', roles: ['product', 'architect', 'developer', 'qa', 'security', 'designer'], budget: 10 });
  assert.equal(actual.ok, true, actual.error);
  await f.flush();
  await f.api.participants(actual.meeting.id, { roles: ['code-reviewer', 'release-manager', 'sre', 'technical-writer'] });
  await f.finish('Claim: Opening context');
  await f.api.stop(actual.meeting.id);
  await f.finish('Claim: New perspective');
  const restarted = createMeetings(f.options); await restarted.ready;
  assert.equal((await restarted.read(actual.meeting.id)).meeting.seats.length, 10);
});

test('restart retains the in-flight allowance, and an ended record cannot turn into a paused meeting', async t => {
  const f = await fixture(t);
  const { meeting: m } = await f.api.start({ topic: 'Storage', roles: ['architect'], budget: 1 });
  await f.flush();
  await f.api.close(m.id);
  const restarted = createMeetings(f.options); await restarted.ready;
  const record = await restarted.read(m.id);
  assert.equal(record.meeting.state, 'ended');
  assert.equal(record.meeting.estimatedSpent, 0.4);
  assert.equal(record.events.at(-1).kind, 'failure');
});

test('specialist asks retain their own confidence and source; an answer links to the question without creating tickets', async t => {
  const f = await fixture(t);
  const { meeting: m } = await f.api.start({ topic: 'Storage', roles: ['architect', 'qa'], budget: 4 });
  await f.finish('Claim: Keep a journal\nConfidence: unsure\nQuestion for the user: How long should recovery take?');
  const q = (await f.api.read(m.id)).meeting.questions[0];
  assert.equal(q.actor, 'architect'); assert.equal(q.confidence, 'unsure');
  await f.api.ask(m.id, { text: 'Under one minute', questionId: q.id });
  const saved = await f.api.read(m.id);
  assert.equal(saved.meeting.questions[0].answer.text, 'Under one minute');
  assert.equal(saved.events.find(e => e.kind === 'decision-answer').questionId, q.id);
  assert.equal(f.tickets.length, 0);
});
