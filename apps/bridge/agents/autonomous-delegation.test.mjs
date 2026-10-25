import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { makeBridge, until } from './host-test-helpers.mjs';
import { makeStateFixture } from '../bridge-fixture.mjs';
import { createClaudeRuntime } from './claude-runtime.mjs';
import { createCodexRuntime } from './codex-runtime.mjs';
import { unconfinedLauncher } from './launcher-test-helpers.mjs';
const closes = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

for (const provider of ['claude', 'codex']) test(`${provider}: a model tool call delegates manager and child, then integrates returned commit`, async () => {
  const fx = await makeStateFixture({ git: true });
  closes.push(fx.cleanup);
  const home = `${fx.root}/home`;
  await mkdir(`${home}/.codex`, { recursive: true });
  await mkdir(`${fx.root}/.codex/agents`, { recursive: true });
  await mkdir(`${fx.root}/.claude/agents`, { recursive: true });
  for (const role of ['chief-of-staff', 'developer']) {
    await writeFile(`${fx.root}/.codex/agents/${role}.toml`, `name = "${role}"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\ndeveloper_instructions = '''\nBe the ${role}.\n'''\n`);
    await writeFile(`${fx.root}/.claude/agents/${role}.md`, `---\nname: ${role}\ntools: Read, Bash\nmodel: sonnet\n---\nBe the ${role}.\n`);
  }
  const git = (...args) => execFileSync('git', ['-C', fx.root, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' });
  git('add', '.codex/agents', '.claude/agents');
  git('commit', '-m', 'probe recipes');
  const stub = new URL('./autonomous-claude-stub.mjs', import.meta.url).pathname;
  const wrapper = `${fx.root}/claude-probe`;
  await writeFile(wrapper, `#!${process.execPath}\nimport ${JSON.stringify(stub)};\n`, { mode: 0o755 });
  await writeFile(`${home}/.codex/auth.json`, '{}', { mode: 0o600 });
  const codexStub = new URL('./codex-stub.mjs', import.meta.url).pathname;
  const runtime = provider === 'claude'
    ? createClaudeRuntime({ controlRoot: fx.root, env: { ...process.env, HOME: home, DEN_CLAUDE_BIN: wrapper }, launcher: unconfinedLauncher() })
    : createCodexRuntime({ controlRoot: fx.root, env: { ...process.env, HOME: home }, native: { codexBin: process.execPath, nativeHelper: codexStub }, codexArgs: [codexStub, 'delegate-loop'], launcher: unconfinedLauncher() });
  const t = await makeBridge({ root: fx.root, noRuntime: true, extra: { runtimes: { [provider]: runtime } } });
  closes.push(t.close);
  const res = await t.post('/conversations/orchestrator/message', { runtime: provider, text: 'Coordinate one independent child check and integrate its commit.' });
  assert.equal(res.status, 201, res.text);
  await until(async () => (await t.state()).agents.some(a => a.id === res.body.runId && a.state === 'done'), { ms: 15000, what: 'lead integration' });
  const events = (await readFile(t.sessionsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const spawns = events.filter(e => e.event === 'spawn');
  assert.equal(spawns.length, 3);
  const lead = spawns.find(e => e.role === 'orchestrator');
  const manager = spawns.find(e => e.orchestration?.kind === 'manager');
  const child = spawns.find(e => e.orchestration?.kind === 'child');
  assert.equal(manager.parent, lead.agentId);
  assert.equal(child.parent, manager.agentId);
  assert.deepEqual([lead, manager, child].map(a => a.execution.tier), ['standard', 'standard', 'bounded']);
  const ended = events.find(e => e.event === 'end' && e.agentId === manager.agentId);
  assert.equal(ended.state, 'done');
  const states = (await t.state()).agents;
  assert.match(states.find(a => a.id === lead.agentId).reply, /Integrated returned evidence/);
  assert.equal(git('show', `${states.find(a => a.id === manager.agentId).branch}:sample.txt`).trim(), 'verified child work');
  if (process.env.DEN_AUTONOMOUS_TRACE) await writeFile(`${process.env.DEN_AUTONOMOUS_TRACE}-${provider}.jsonl`, spawns.map(({ agentId, parent, runtime, execution, orchestration }) => JSON.stringify({ agentId, parent: parent ?? null, runtime, execution, kind: orchestration?.kind ?? 'lead' })).join('\n') + '\n');
});
