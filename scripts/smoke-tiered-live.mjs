// Explicit, bounded live-provider verification. Never imported by the normal test suite.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createClaudeRuntime } from '../apps/bridge/agents/claude-runtime.mjs';
import { createCodexRuntime } from '../apps/bridge/agents/codex-runtime.mjs';
import { startBridge } from '../apps/bridge/server.mjs';
import { makeStateFixture } from '../apps/bridge/bridge-fixture.mjs';
import { CODE, login, authed, send } from '../apps/bridge/bridge-auth-helpers.mjs';
import { cleanText } from '../apps/shared/safe-text.mjs';

const provider = process.argv[2];
if (!['claude', 'codex'].includes(provider)) throw new Error('Usage: node scripts/smoke-tiered-live.mjs claude|codex [evidence-directory]');
const output = process.argv[3] ?? '/tmp/den-tiered-live';
await mkdir(output, { recursive: true });
const rootRepo = fileURLToPath(new URL('..', import.meta.url));
const fixture = await makeStateFixture({ git: true });
const rows = [];
const note = fields => rows.push({ at: new Date().toISOString(), provider, ...fields });
let bridge;
let calls = 0;
let delegations = 0;
let delegateRequests = 0;
let deadline;
let result;
const runtimeFiles = ['apps/bridge/server.mjs', 'apps/bridge/agents/host.mjs', 'apps/bridge/agents/orchestration.mjs', 'apps/bridge/agents/claude-runtime.mjs', 'apps/bridge/agents/claude-adapter.mjs', 'apps/bridge/agents/codex-runtime.mjs', 'apps/bridge/agents/codex-adapter.mjs', 'apps/bridge/agents/codex-governed-paths.mjs', 'apps/bridge/agents/codex-permissions.mjs', 'apps/bridge/agents/resource-group.mjs', 'apps/bridge/library/servers/den.mjs', 'apps/bridge/library/servers/delegation.mjs'];
const runtimeHash = createHash('sha256');
for (const file of runtimeFiles) runtimeHash.update(file).update('\0').update(await readFile(`${rootRepo}/${file}`)).update('\0');
const runtimeSourceSha256 = runtimeHash.digest('hex');
const marker = `LIVE DELEGATION OK ${provider} ${randomInt(100000, 999999)}`;
const request = {
  issue: 'live-smoke-marker', kind: 'implementer', role: 'developer',
  task: 'Read smoke-marker.txt and return its exact contents. Do nothing else.',
  reason: 'Tiny live smoke of one focused managed delegation', files: ['smoke-marker.txt'],
  constraints: ['Read only. No edits, commits, other files, network, skills, or additional agents. Stop on the first error.'],
  acceptance: ['Return the exact marker from smoke-marker.txt.'], execution: { tier: 'bounded', speed: 'standard' },
};
const job = 'You are a live smoke probe in a disposable repository. Do only the user request. Do not load skills, inspect the board, run unrelated checks, or modify files. No retries. End immediately on failure. The only delegated work allowed is reading smoke-marker.txt.';
try {
  await mkdir(`${fixture.root}/.claude/agents`, { recursive: true });
  await mkdir(`${fixture.root}/.codex/agents`, { recursive: true });
  for (const role of ['chief-of-staff', 'developer']) {
    await writeFile(`${fixture.root}/.claude/agents/${role}.md`, `---\nname: ${role}\ndescription: Tiny live smoke probe\ntools: Read\nmodel: sonnet\n---\n${job}\n`);
    await writeFile(`${fixture.root}/.codex/agents/${role}.toml`, `name = "${role}"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\ndeveloper_instructions = '''\n${job}\n'''\n`);
  }
  await writeFile(`${fixture.root}/smoke-marker.txt`, marker + '\n');
  const git = (...args) => execFileSync('git', ['-C', fixture.root, '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' }).trim();
  git('add', '.claude/agents', '.codex/agents', 'smoke-marker.txt');
  git('commit', '-m', 'bounded live delegation probe');
  note({ event: 'probe', live: true, runtimeSourceSha256, runtimeFiles, sourceHead: execFileSync('git', ['-C', rootRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fixtureHead: git('rev-parse', 'HEAD'), limits: { processes: 2, delegations: 1, deadlineMs: 90000 }, sandbox: 'production runtime and enforced launcher; no overrides' });
  const native = provider === 'claude' ? createClaudeRuntime({ controlRoot: fixture.root }) : createCodexRuntime({ controlRoot: fixture.root });
  const preflight = await native.preflight();
  note({ event: 'preflight', ...preflight });
  if (!preflight.ok) throw new Error(preflight.reason);
  const runtime = { ...native, async spawn(args) {
    if (calls >= 2) throw new Error('live smoke process limit reached');
    calls += 1;
    if (args.role !== 'orchestrator') delegations += 1;
    note({ event: 'invocation', agentId: args.runId, role: args.role, execution: args.execution, enforced: native.enforced });
    const delegate = args.delegate && (async input => {
      if (++delegateRequests > 1 || !isDeepStrictEqual(input, request)) return { ok: false, error: 'Smoke permits only the one exact read-only delegate request; stop without retrying.' };
      note({ event: 'delegation-call', agentId: args.runId, issue: input.issue, kind: input.kind, role: input.role, execution: input.execution });
      const returned = await args.delegate(input);
      note({ event: 'delegation-result', agentId: args.runId, result: returned });
      return returned;
    });
    let proc;
    try { proc = await native.spawn({ ...args, ...(delegate ? { delegate } : {}) }); }
    catch (error) { note({ event: 'launch-error', agentId: args.runId, error: cleanText(String(error.message)) }); throw error; }
    const source = proc.events;
    return { ...proc, events: { async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        if (['model', 'usage', 'done', 'tool-start', 'tool-end'].includes(event.type)) note({ event: 'provider-event', agentId: args.runId, data: event });
        yield event;
      }
    } } };
  } };
  bridge = await startBridge({ root: fixture.root, port: 0, auth: { launchCode: CODE }, runtimes: { [provider]: runtime } });
  const token = await login(bridge);
  const task = `Call ${provider === 'claude' ? 'mcp__delegation__delegate' : 'delegate'} exactly once with this JSON, preserving every field and value: ${JSON.stringify(request)}. Then return the child's exact marker and stop. Do not create a manager or use any other tool. No retries.`;
  deadline = setTimeout(() => { note({ event: 'deadline' }); bridge.host.shutdown(); }, 90000);
  const started = await send(bridge, { method: 'POST', path: '/conversations/orchestrator/message', headers: authed(bridge, token), body: { runtime: provider, text: task } });
  note({ event: 'start-response', status: started.status, body: started.body });
  if (started.status !== 201) throw new Error(started.body.error ?? 'lead refused');
  let agents;
  const stopAt = Date.now() + 90000;
  for (;;) {
    agents = (await send(bridge, { path: '/state' })).body.agents;
    const lead = agents.find(a => a.id === started.body.runId);
    if (lead && ['done', 'failed', 'terminated'].includes(lead.state)) break;
    if (Date.now() >= stopAt) throw new Error('live smoke timed out');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const child = agents.find(a => a.parent === started.body.runId);
  const lead = agents.find(a => a.id === started.body.runId);
  result = { ok: calls === 2 && delegations === 1 && child?.state === 'done' && lead?.state === 'done' && lead.reply?.includes(marker), provider, calls, delegations,
    agents: agents.map(a => ({ id: a.id, parent: a.parent, role: a.role, state: a.state, model: a.model, execution: a.execution, usage: a.usage ?? null, costUsd: a.costUsd ?? null, reply: a.reply, reason: a.reason })) };
} catch (error) {
  result = { ok: false, provider, calls, delegations, error: cleanText(String(error.message)).slice(0, 1000) };
} finally {
  clearTimeout(deadline);
  await bridge?.close();
  try {
    const sessionRows = (await readFile(`${fixture.root}/.scratch/_run/sessions.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    for (const row of sessionRows) if (['spawn', 'end', 'stop'].includes(row.event)) note({ event: 'host-session', data: row });
  } catch {}
  note({ event: 'result', result });
  await writeFile(`${output}/${provider}.jsonl`, cleanText(rows.map(row => JSON.stringify(row)).join('\n')) + '\n');
  await writeFile(`${output}/${provider}-result.json`, JSON.stringify(result, null, 2) + '\n');
  await fixture.cleanup();
}
console.log(JSON.stringify({ ...result, trace: `${output}/${provider}.jsonl` }));
if (!result.ok) process.exitCode = 1;
