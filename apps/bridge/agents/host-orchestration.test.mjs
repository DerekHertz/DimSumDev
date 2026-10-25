import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeBridge, until } from './host-test-helpers.mjs';
import { createSessions } from './sessions.mjs';
import { createFakeRuntime } from './runtime.mjs';

let t;
afterEach(async () => { await t?.close(); t = null; });
const brief = (kind, extra = {}) => ({ kind, task: 'Check formatter', reason: 'Independent targeted check', files: ['formatter.mjs'], constraints: ['No dependencies'], acceptance: ['Targeted tests pass'], ...extra });
const task = body => t.post('/tasks', { text: 'Bounded formatter update', ...body });
const rows = async () => (await readFile(t.sessionsFile, 'utf8')).trim().split('\n').map(JSON.parse);

test('a simple task defaults to one implementer on the direct path; invalid overrides launch nothing', async () => {
  t = await makeBridge();
  const rejected = await task({ execution: { speed: 'fast' } });
  assert.equal(rejected.status, 400);
  assert.equal(t.fake.spawns.length, 0);
  const res = await task({});
  assert.equal(res.status, 201, res.text);
  assert.equal(t.fake.spawns.length, 1);
  const { args } = t.fake.spawns[0];
  assert.deepEqual([args.role, args.execution.model, args.execution.reasoning, args.execution.speed], ['developer', 'haiku', 'low', 'standard']);
  assert.equal(res.body.agent.parent, null);
  assert.equal(res.body.agent.orchestration, null);
  assert.equal(res.body.agent.usage, null);
});

test('Codex manager and bounded child share the host lifecycle and expose an execution trace', async () => {
  const codex = createFakeRuntime();
  const spawn = codex.spawn;
  codex.spawn = async args => Object.assign(await spawn(args), { runtimeSessionId: `thread-${args.runId}` });
  t = await makeBridge({ noRuntime: true, extra: { runtimes: { codex } } });
  const manager = await task({ runtime: 'codex', orchestration: brief('manager', { task: 'Coordinate independent formatter and docs changes', files: ['formatter.mjs', 'README.md'] }) });
  assert.equal(manager.status, 201, manager.text);
  const child = await task({ runtime: 'codex', orchestration: brief('child', { parent: manager.body.agent.id }) });
  assert.equal(child.status, 201, child.text);
  assert.equal(codex.spawns.length, 2, 'no full hierarchy launch');
  assert.deepEqual(codex.spawns.map(s => s.args.execution.model), ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.equal(manager.body.agent.parent, 'jiao');
  assert.equal(child.body.agent.parent, manager.body.agent.id);
  assert.match(codex.spawns[1].args.prompt, /Focused delegation/);
  assert.match(codex.spawns[1].args.prompt, /already been delegated/);
  assert.match(codex.spawns[1].args.prompt, /Perform this brief directly/);
  assert.match(codex.spawns[1].args.prompt, /No delegate tool is provided or needed/);
  codex.spawns[1].emit({ type: 'done', ok: true });
  await until(async () => (await t.agent(child.body.agent.id))?.state === 'done', { what: 'first child completion' });
  const docs = await task({ runtime: 'codex', orchestration: brief('child', { parent: manager.body.agent.id, task: 'Check documentation', files: ['README.md'] }) });
  assert.equal(docs.status, 201, docs.text);
  assert.equal(codex.spawns.length, 3, 'one manager and two requested children, not 21 agents');
  assert.equal(codex.peakLive, 2, 'children share the existing global worker budget');
  assert.equal(codex.spawns[2].args.execution.model, 'gpt-6-luna');
  const trace = (await rows()).filter(r => r.event === 'spawn');
  assert.equal(trace[1].parent, manager.body.agent.id);
  assert.deepEqual(trace[1].execution, child.body.agent.execution);
  assert.equal(trace[1].usage, null, 'unmeasured usage is unknown');
  const replayed = await createSessions(t.fx.root).replay();
  assert.deepEqual(replayed[1].execution, child.body.agent.execution);
  assert.equal(replayed[1].parent, manager.body.agent.id);
  if (process.env.DEN_TIER_TRACE) await writeFile(process.env.DEN_TIER_TRACE, trace.map(({ agentId, parent, runtime, execution, usage }) => JSON.stringify({ agentId, parent, runtime, execution, usage })).join('\n') + '\n');
  assert.equal((await t.post(`/agents/${manager.body.agent.id}/stop`)).status, 202);
  await until(async () => (await t.agent(docs.body.agent.id))?.state === 'terminated', { what: 'child cancellation' });
  assert.ok(codex.spawns[2].calls.some(c => c.call === 'closeInput'));
});

test('concurrent managers cannot each allocate their own worker cap', async () => {
  t = await makeBridge();
  const first = await task({ orchestration: brief('manager') });
  const second = await task({ orchestration: brief('manager', { task: 'Coordinate docs', files: ['docs.md'] }) });
  assert.equal(first.status, 201, first.text);
  assert.equal(second.status, 201, second.text);
  const children = await Promise.all([first, second].map(r => task({ orchestration: brief('child', { parent: r.body.agent.id }) })));
  assert.deepEqual(children.map(r => r.status), [429, 429]);
  assert.equal(t.fake.spawns.length, 2);
  assert.equal(t.fake.peakLive, 2);
});

test('real HTTP dispatch preserves task overrides, delegation and records them', async () => {
  t = await makeBridge();
  const res = await t.post('/agents', { role: 'developer', ref: 'fx/02-ready-p0', execution: { tier: 'hard', reasoning: 'medium', reason: 'Cross-module integration' }, orchestration: brief('manager') });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual([t.fake.spawns[0].args.execution.model, t.fake.spawns[0].args.execution.reasoning], ['opus', 'medium']);
  assert.equal(res.body.agent.parent, 'bao');
});
