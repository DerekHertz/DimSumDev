import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentFor, cardFor, costLabel, START_ROLES, STATE_LABELS } from './proximity-card.mjs';
import { LIVE_STATES } from '../../../bridge/agents/policy.mjs';
import { ROLES } from '../../../bridge/agents/policy.mjs';

test('walking toward pandas shows the nearest one in reach and facing the viewer', () => {
  const pandas = [
    { id: 'far', name: 'Far', role: 'qa', position: { x: 0, z: -2.8 } },
    { id: 'near', name: 'Near', role: 'developer', position: { x: 0, z: -1.5 } },
    { id: 'behind', role: 'scout', position: { x: 0, z: 0.4 } },
  ];
  assert.equal(cardFor(pandas, [], { x: 0, z: 0, yaw: 0 }).id, 'near');
  assert.equal(cardFor(pandas, [], { x: 0, z: 0, yaw: Math.PI }).id, 'behind');
  assert.equal(cardFor(pandas, [], { x: 8, z: 0, yaw: 0 }), null);
  assert.equal(cardFor(pandas.slice(0, 2), [], { x: 0, z: 0, yaw: Math.PI }), null);
});

test('the bound agent supplies state, ticket, tool and runtime capability flags', () => {
  const agent = { id: 'c-live', ref: 'den-v1/04-proximity-card', state: 'needs-you', tool: { name: 'Read', summary: 'card model' }, capabilities: { send: false, approve: true } };
  const panda = { id: 'developer', role: 'developer', position: { x: -2, z: 0 }, agent };
  const approval = { id: 'a-live', agentId: 'c-live', status: 'pending', tool: 'Read' };
  const card = cardFor([panda], [approval], { x: 0, z: 0, yaw: Math.PI / 2 });
  assert.equal(card.agentId, 'c-live');
  assert.equal(card.ref, 'den-v1/04-proximity-card');
  assert.equal(card.state, 'needs-you');
  assert.deepEqual(card.tool, { name: 'Read', summary: 'card model' });
  assert.equal(card.approval.id, 'a-live');
  assert.deepEqual(card.actions.T, { enabled: false, reason: 'runtime cannot send messages' });
  assert.deepEqual(card.actions.R, { enabled: true, reason: null });
  assert.deepEqual(card.actions.E, { enabled: true, reason: null });
  assert.deepEqual(card.actions.Q, { enabled: true, reason: null });

  agent.capabilities = { send: true, approve: false };
  const unsupported = cardFor([panda], [approval], { x: 0, z: 0, yaw: Math.PI / 2 });
  assert.equal(unsupported.actions.T.enabled, true);
  assert.deepEqual(unsupported.actions.E, { enabled: false, reason: 'runtime cannot answer permissions' });
});

// den-v1 loop S1: T on a resident starts a task for that role, so it is enabled when the role is one the bridge can start.
test('a resident with no live agent keeps its role; T starts a task and the other actions stay off with a reason', () => {
  const resident = { id: 'qa', name: 'Mei', role: 'qa', team: 'Tea', position: { x: 0, z: -2 } };
  const card = cardFor([resident], [], { x: 0, z: 0, yaw: 0 });
  assert.equal(card.role, 'qa');
  assert.equal(card.agentId, null);
  assert.equal(card.state, 'resident');
  assert.equal(card.start, true);
  assert.deepEqual(card.actions.T, { enabled: true, reason: null });
  for (const key of ['R', 'E', 'Q']) {
    assert.deepEqual(card.actions[key], { enabled: false, reason: 'no agent running' });
  }
});

test('the roles T can start are the bridge\'s; a resident with any other role, or a scenery panda, keeps T off', () => {
  assert.deepEqual([...START_ROLES].sort(), [...ROLES].sort());
  // team-and-den-ux/02: the Drummer is scenery with the release manager's role name; it stays scenery until 03.
  const drummer = cardFor([{ id: 'p', role: 'release-manager', dispatchable: false, position: { x: 0, z: -2 } }], [], { x: 0, z: 0, yaw: 0 });
  assert.equal(drummer.start, false);
  assert.equal(cardFor([{ id: 'p', role: 'code-reviewer', position: { x: 0, z: -2 } }], [], { x: 0, z: 0, yaw: 0 }).start, true);
  for (const role of ['debugger', 'stem-cub', undefined]) {
    const card = cardFor([{ id: 'p', role, position: { x: 0, z: -2 } }], [], { x: 0, z: 0, yaw: 0 });
    assert.equal(card.start, false);
    assert.deepEqual(card.actions.T, { enabled: false, reason: 'no agent running' });
  }
  const live = { id: 'c-1', state: 'working', capabilities: { send: true } };
  assert.equal(cardFor([{ id: 'p', role: 'qa', position: { x: 0, z: -2 }, agent: live }], [], { x: 0, z: 0, yaw: 0 }).start, false, 'a panda with a live agent gets a message, not a new task');
});

test('permission actions need a pending request for this agent; ended agents return to resident', () => {
  const agent = { id: 'c-qa', state: 'working', capabilities: { approve: true, send: true } };
  const panda = { id: 'qa', role: 'qa', position: { x: 0, z: -2 }, agent };
  const viewer = { x: 0, z: 0, yaw: 0 };
  for (const approvals of [[], [{ id: 'a-other', agentId: 'c-other' }], [{ id: 'a-done', agentId: 'c-qa', status: 'answered', decision: 'deny' }]]) {
    const card = cardFor([panda], approvals, viewer);
    assert.equal(card.approval, null);
    assert.deepEqual(card.actions.E, { enabled: false, reason: 'no pending permission request' });
    assert.deepEqual(card.actions.Q, card.actions.E);
  }
  for (const state of ['done', 'failed', 'terminated']) {
    agent.state = state;
    const card = cardFor([panda], [{ id: 'a-stale', agentId: 'c-qa' }], viewer);
    assert.equal(card.agentId, null);
    assert.equal(card.state, 'resident');
    assert.equal(card.start, true, 'an ended agent leaves a resident that can be given a new task');
    // den-mvp outcome 2: the ended run's thread still opens, so it can be read and followed up.
    assert.deepEqual([card.actions.R.enabled, card.threadId], [true, 'c-qa']);
  }
});

test('reach and facing use world coordinates and ignore missing positions', () => {
  const viewer = { x: 10, z: 6, yaw: -Math.PI / 2 };
  assert.equal(cardFor([{ id: 'edge', position: { x: 13.25, z: 6 } }], [], viewer).id, 'edge');
  assert.equal(cardFor([{ id: 'out', position: { x: 13.26, z: 6 } }], [], viewer), null);
  assert.equal(cardFor([{ id: 'side', position: { x: 10, z: 5 } }], [], viewer), null);
  assert.equal(cardFor([{ id: 'unknown' }], [], viewer), null);
  assert.equal(cardFor([], [], null), null);
});

test('a board-bound panda keeps its working details even before it has a bridge control handle', () => {
  const panda = { id: 'developer', role: 'developer', position: { x: 0, z: -2 }, ref: 'fx/04-card', state: 'working', tool: { name: 'Read', summary: 'ticket' } };
  const card = cardFor([panda], [], { x: 0, z: 0, yaw: 0 });
  assert.equal(card.ref, 'fx/04-card');
  assert.equal(card.state, 'working');
  assert.deepEqual(card.tool, { name: 'Read', summary: 'ticket' });
  assert.equal(card.agentId, null);
  assert.equal(card.actions.T.reason, 'agent controls unavailable');
  assert.equal(card.start, false);
});

// ---- den-v1 loop S4: the result on the card ------------------------------------------------------------------------
// card.last = { state, ref, label, reply, cost, costExact } for a panda whose newest agent has ended, else null.
// cost is the badge text made from the agent's costUsd (the CLI's own figure); costExact is that figure in full.
const viewer = { x: 0, z: 0, yaw: 0 };
const ended = (over = {}) => ({ id: 'c-old', ref: 'den/07-scout', role: 'scout', state: 'done', reply: 'Counted 12 baskets.', costUsd: 0.34, ...over });
const scout = (agent) => ({ id: 'scout', name: 'Bo', role: 'scout', team: 'Steamers', position: { x: 0, z: -2 }, ...(agent ? { agent } : {}) });

test('costLabel reads the reported cost to two figures and says it is an API-equivalent', () => {
  assert.equal(costLabel(0.34), '≈34¢ API-equiv');
  assert.equal(costLabel(0.0006970399999999999), '≈0.07¢ API-equiv');
  assert.equal(costLabel(0.00131197), '≈0.13¢ API-equiv');
  assert.equal(costLabel(0.034), '≈3.4¢ API-equiv');
  assert.equal(costLabel(0.999), '≈$1.00 API-equiv');
  assert.equal(costLabel(1.234), '≈$1.23 API-equiv');
  assert.equal(costLabel(12), '≈$12.00 API-equiv');
  assert.equal(costLabel(0), '0¢ API-equiv');
  assert.equal(costLabel(0.00000001), '<0.01¢ API-equiv');
  for (const bad of [null, undefined, '0.34', -1, Number.NaN, Number.POSITIVE_INFINITY, {}, [0.34]]) assert.equal(costLabel(bad), null, String(bad));
});

test('an ended agent leaves its result on the resident card: outcome, reply and the cost badge', () => {
  const card = cardFor([scout(ended())], [], viewer);
  assert.equal(card.state, 'resident');
  assert.equal(card.start, true, 'T still starts the next task');
  assert.deepEqual(card.last, {
    state: 'done', ref: 'den/07-scout', label: 'Last task: done', reply: 'Counted 12 baskets.',
    cost: '≈34¢ API-equiv', costExact: '$0.340000 reported by the CLI',
  });
  assert.equal(cardFor([scout(ended({ state: 'failed' }))], [], viewer).last.label, 'Last task: failed');
  assert.equal(cardFor([scout(ended({ state: 'terminated' }))], [], viewer).last.label, 'Last task: stopped');
});

test('a result with no reply or no cost shows what it has', () => {
  const bare = cardFor([scout(ended({ reply: null, costUsd: null }))], [], viewer).last;
  assert.deepEqual([bare.label, bare.reply, bare.cost, bare.costExact], ['Last task: done', null, null, null]);
  const odd = cardFor([scout(ended({ reply: 7, costUsd: '1', ref: undefined }))], [], viewer).last;
  assert.deepEqual([odd.reply, odd.cost, odd.ref], [null, null, null]);
});

test('a live agent, or a panda with no agent, has no result line', () => {
  assert.equal(cardFor([scout({ id: 'c-1', state: 'working', costUsd: 0.1, reply: 'early', capabilities: {} })], [], viewer).last, null);
  assert.equal(cardFor([scout()], [], viewer).last, null);
});

test('every live state the bridge reports has a label on the card', () => {
  for (const state of [...LIVE_STATES, 'resident', 'needs-you']) assert.equal(typeof STATE_LABELS[state], 'string', state);
  assert.equal(STATE_LABELS.waiting_on_user, 'Needs your answer');
});

// Which bridge agent a panda's card reads. The board binds a panda to a ticket only while a claim lock names its
// role; a den-started agent runs before it claims, and its result outlives the claim, so an unbound panda reads the
// newest agent of its role.
test('agentFor: a ticket-bound panda reads its ticket\'s agent; an unbound panda reads the newest agent of its role', () => {
  const agents = [
    { id: 'c-1', ref: 'den/01-scout', role: 'scout', state: 'done' },
    { id: 'c-2', ref: 'fx/02-ready', role: 'architect', state: 'working' },
    { id: 'c-3', ref: 'den/02-scout', role: 'scout', state: 'working' },
    { id: 'c-4', ref: 'den/03-scout', role: 'scout', state: 'failed' },
  ];
  assert.equal(agentFor({ role: 'scout' }, agents).id, 'c-3', 'a live agent comes before a newer ended one');
  assert.equal(agentFor({ role: 'scout' }, agents.filter((a) => a.id !== 'c-3')).id, 'c-4', 'else the newest ended one: its result');
  assert.equal(agentFor({ role: 'scout', ref: 'den/01-scout' }, agents).id, 'c-1', 'a bound panda reads its own ticket only');
  assert.equal(agentFor({ role: 'scout', ref: 'fx/09-other' }, agents), null, 'a bound panda with no bridge agent keeps its board details');
  assert.equal(agentFor({ role: 'architect', ref: 'den/02-scout' }, agents), null, 'the role must match too');
  assert.equal(agentFor({ role: 'scout' }, agents, new Set(['den/02-scout', 'den/03-scout'])).id, 'c-1', 'agents another panda shows are skipped');
  assert.equal(agentFor({ role: 'qa' }, agents), null);
  for (const none of [undefined, null, [], 'x']) assert.equal(agentFor({ role: 'scout' }, none), null);
  assert.equal(agentFor({ role: 'scout' }, [null, 7, { role: 'scout' }, agents[0]]).id, 'c-1', 'rows without an id are skipped');
});

test('the card component renders the result, and the scene binds cards through agentFor', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const jsx = read('./ProximityCard.jsx');
  for (const part of ['card.last.label', 'card.last.reply', 'card.last.cost', 'card.last.costExact', 'proximity-cost', 'STATE_LABELS']) assert.ok(jsx.includes(part), `ProximityCard.jsx uses ${part}`);
  assert.match(read('../scene/procedural/RestaurantDen.jsx'), /agentFor\(/);
  assert.match(read('../scene/procedural/den.css'), /\.proximity-cost\b/);
});

test("the card's actions are the QERT row, in keyboard order: Q deny, E allow, R transcript, T message", () => {
  const source = readFileSync(new URL("./ProximityCard.jsx", import.meta.url), "utf8");
  assert.match(source, /const LABELS = \{ Q: 'Deny', E: 'Allow', R: 'Transcript', T: 'Message' \};/);
  const panel = readFileSync(new URL("./ApprovalPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /Deny <kbd>Q<\/kbd>/);
  assert.match(panel, /Allow <kbd>E<\/kbd>/);
  assert.doesNotMatch(source + panel, /data-key=[ADF]\b|<kbd>[ADF]<\/kbd>/);
});

// den-mvp/30: Bao's thread always opens. With no run it is the desk's thread, where the first message starts one.
test("Bao with no run: R opens the desk thread; with a run, its own; other residents keep R off", () => {
  const bao = { id: 'bao', name: 'Bao', role: 'orchestrator', team: 'Pass', position: { x: 0, z: -2 } };
  const card = cardFor([bao], [], { x: 0, z: 0, yaw: 0 });
  assert.deepEqual(card.actions.R, { enabled: true, reason: null });
  assert.deepEqual([card.agentId, card.threadId], [null, 'desk']);
  const busy = cardFor([{ ...bao, agent: { id: 'c-1111111111111111', role: 'orchestrator', state: 'working' } }], [], { x: 0, z: 0, yaw: 0 });
  assert.equal(busy.threadId, 'c-1111111111111111');
  const old = cardFor([{ ...bao, agent: { id: 'c-2222222222222222', ref: 'agent-os/05-old', role: 'orchestrator', state: 'done' } }], [], { x: 0, z: 0, yaw: 0 });
  assert.equal(old.threadId, 'desk', "an ended run on another ticket is not where Bao's thread goes");
  const lastDesk = cardFor([{ ...bao, agent: { id: 'c-3333333333333333', ref: 'den/00-bao', role: 'orchestrator', state: 'done' } }], [], { x: 0, z: 0, yaw: 0 });
  assert.equal(lastDesk.threadId, 'c-3333333333333333', 'the last desk run is followed up');
  const mei = cardFor([{ ...bao, id: 'qa', role: 'qa' }], [], { x: 0, z: 0, yaw: 0 });
  assert.equal(mei.actions.R.enabled, false);
  assert.equal(mei.threadId, null);
});
