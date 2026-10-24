import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeetings } from './runner.mjs';

async function fixture(roles = ['architect'], ref = null, budget = 20) {
  const starts = [];
  const holds = { claims: 0, releases: 0 };
  const api = createMeetings({
    log: { replay: async () => [], save: async () => {} },
    host: { start: async body => { starts.push(body); return { ok: true, agent: { id: `c-${String(starts.length).padStart(16, '0')}` } }; }, stop: async () => {} },
    readTicket: async () => ({ title: 'Task', status: 'ready-for-agent' }),
    claimTicket: async () => { holds.claims++; },
    releaseTicket: async () => { holds.releases++; },
    proposeTicket: async () => { throw new Error('No ticket should be created'); },
  });
  await api.ready;
  const start = await api.start({ topic: 'Recovery design', roles, budget, ...(ref ? { ref } : {}) });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  const id = start.meeting.id;
  const finish = async report => { await api.onEnd({ agentId: api.snapshot()[0].live.runId, state: 'done', report, costUsd: 0.1 }); await flush(); };
  return { api, id, starts, finish, flush, holds };
}

test('linked response can be sent with no optional instruction', async () => {
  const f = await fixture();
  await f.finish('Claim: One journal');
  const sourceId = (await f.api.read(f.id)).events.find(e => e.kind === 'message').id;
  const response = await f.api.ask(f.id, { reask: 'architect', sourceId });
  assert.equal(response.ok, true, `expected linked reply request to be accepted; actual ${JSON.stringify(response)}`);
});

test('a fully paused meeting releases its task hold as retained den-mvp/66 criteria require', async () => {
  const f = await fixture(['architect'], 'den/08-task');
  assert.equal(f.holds.claims, 1);
  await f.api.stop(f.id);
  assert.equal(f.holds.releases, 0, 'in-flight work must retain its hold');
  await f.finish('Claim: One journal');
  assert.equal(f.api.snapshot()[0].state, 'paused');
  assert.equal(f.holds.releases, 1, 'paused meetings hold nothing once the in-flight response ends');
});

test('a redirect queued during moderation is applied after that response even if its stale plan says settled', async () => {
  const f = await fixture();
  await f.finish('Claim: One journal');
  await f.api.ask(f.id, { text: 'Reconsider using a file per task before settling' });
  await f.finish(JSON.stringify({ action: 'settled', summary: 'One journal', followUps: [] }));
  const current = await f.api.read(f.id);
  assert.equal(current.meeting.state, 'running', `redirect remained pending but state=${current.meeting.state}, starts=${f.starts.length}`);
  assert.equal(f.starts.length, 3);
  assert.match(f.starts.at(-1).meeting.file, /Reconsider using a file per task/);
});

test('pausing an independent opening round does not expose its first take to the remaining opening specialist', async () => {
  const f = await fixture(['architect', 'qa']);
  await f.api.stop(f.id);
  await f.finish('Claim: ARCHITECT-INDEPENDENT-OPENING');
  await f.api.resume(f.id); await f.flush();
  assert.equal(f.starts[1].role, 'qa');
  assert.equal(f.starts[1].meeting.file.includes('ARCHITECT-INDEPENDENT-OPENING'), false, 'the not-yet-asked opening specialist received the first specialist’s take after Pause/Resume');
});

test('an ended meeting retains its hold until the actual in-flight response ends', async () => {
  const f = await fixture(['architect'], 'den/08-task');
  await f.api.close(f.id);
  assert.equal(f.holds.releases, 0, 'a cancellation request does not prove that the run ended');
  assert.notEqual(f.api.snapshot()[0].live, null);
  await f.finish('Final response while ending');
  assert.equal(f.holds.releases, 1);
  assert.equal(f.api.snapshot()[0].state, 'ended');
});

test('ending retains a recorded partial contribution without counting it as successful input', async () => {
  const f = await fixture(['architect'], 'den/08-task');
  await f.api.close(f.id);
  await f.api.onEnd({ agentId: f.api.snapshot()[0].live.runId, state: 'terminated', report: 'Recorded partial recovery analysis', costUsd: 0.1 });
  const record = await f.api.read(f.id);
  const contribution = record.events.find(e => e.kind === 'failure');
  assert.equal(contribution.text, 'Recorded partial recovery analysis');
  assert.equal(contribution.partial, true);
  assert.equal(record.meeting.seats[0].status, 'failed');
  assert.equal(record.meeting.state, 'ended');
});

test('send-back revisits the relevant specialists with its source and no ticket creation', async () => {
  const f = await fixture(['architect', 'qa']);
  await f.finish('Claim: One journal');
  await f.finish('Claim: Many journals');
  const sourceId = (await f.api.read(f.id)).events.find(e => e.actor === 'qa' && e.kind === 'message').id;
  await f.finish(JSON.stringify({ action: 'decision', question: 'Which journal?', options: [{ key: 'A', title: 'One', tradeoff: 'Simple but grows' }, { key: 'B', title: 'Many', tradeoff: 'Small but dispersed' }], recommended: 'A', required: ['architect', 'qa'], sourceIds: [sourceId] }));
  const decision = await f.api.decide(f.id, { sendBack: true, text: 'Revisit failure recovery' });
  assert.equal(decision.ok, true);
  await f.flush();
  assert.equal(f.starts.at(-1).role, 'architect');
  assert.match(f.starts.at(-1).meeting.file, /Revisit failure recovery/);
  await f.finish('Claim: Improved recovery plan');
  assert.equal(f.starts.at(-1).role, 'qa');
  assert.match(f.starts.at(-1).meeting.file, /Improved recovery plan/);
});

test('a specialist decline remains private and is identified to the moderator as missing input', async () => {
  const f = await fixture();
  await f.finish('DECLINE: PRIVATE-DECLINE-CONTEXT is outside this role');
  const record = await f.api.read(f.id);
  assert.equal(record.meeting.seats[0].status, 'declined');
  assert.equal(record.events.find(e => e.kind === 'decline').actor, 'architect');
  assert.match(f.starts.at(-1).meeting.file, /architect declined/);
  assert.equal(JSON.stringify(f.api.publicSnapshot()).includes('PRIVATE-DECLINE-CONTEXT'), false);
});

for (const mode of ['reply', 'budget', 'pause', 'end', 'invalid-plan']) {
  test(`queued reply after missing-input moderation respects ${mode}`, async () => {
    const f = await fixture(['architect', 'qa'], null, mode === 'budget' ? 0.65 : 20);
    await f.finish('Claim: One journal');
    await f.api.onEnd({ agentId: f.api.snapshot()[0].live.runId, state: 'failed', costUsd: 0.1 });
    await f.flush();
    const sourceId = (await f.api.read(f.id)).events.find(e => e.kind === 'message').id;
    assert.equal((await f.api.ask(f.id, { sourceId, reask: 'qa' })).ok, true);
    if (mode === 'pause') await f.api.stop(f.id);
    if (mode === 'end') await f.api.close(f.id);
    const plan = { action: 'decision', question: 'Which journal?', options: [{ key: 'A', title: 'One', tradeoff: 'Simple but grows' }, { key: 'B', title: 'Many', tradeoff: 'Small but dispersed' }], recommended: 'A', required: ['qa'], sourceIds: [sourceId] };
    await f.finish(mode === 'invalid-plan' ? 'invalid' : JSON.stringify(plan));
    const record = await f.api.read(f.id);
    if (mode === 'reply') {
      assert.equal(f.starts.length, 4, `queued response stranded: state=${record.meeting.state}`);
      assert.equal(f.starts.at(-1).role, 'qa');
      assert.equal(record.meeting.queue.length, 0);
      assert.equal(record.meeting.state, 'running');
      assert.equal((await f.api.decide(f.id, { option: 'A' })).status, 409);
      assert.equal((await f.api.retry(f.id, { role: 'qa' })).status, 409);
    } else {
      assert.equal(f.starts.length, 3);
      assert.equal(record.meeting.state, mode === 'end' ? 'ended' : mode === 'budget' ? 'waiting-budget' : 'paused');
      if (mode === 'budget') {
        assert.equal(record.meeting.queue.length, 1);
        assert.equal((await f.api.decide(f.id, { option: 'A' })).status, 409);
        await f.api.approveBudget(f.id, { budget: 2 });
        assert.equal(f.starts.length, 4);
        assert.equal(f.starts.at(-1).role, 'qa');
      }
    }
  });
}
