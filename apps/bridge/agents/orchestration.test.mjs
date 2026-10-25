import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionSettings, delegation, checkDelegation } from './orchestration.mjs';
import { buildClaudeArgs } from './claude-adapter.mjs';

const brief = (kind, more = {}) => delegation({ kind, task: 'Update formatter', reason: 'Independent formatting work', files: ['a.mjs'], constraints: ['No dependencies'], acceptance: ['Targeted check passes'], ...more });
const manager = (id, runtimeId = 'codex', project = 'den') => ({ id, runtimeId, project, orchestration: brief('manager') });

test('provider tiers route bounded work cheaply and preserve explicit overrides', () => {
  for (const [provider, models] of [['codex', ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']], ['claude', ['haiku', 'sonnet', 'opus']]]) {
    assert.equal(executionSettings(provider, 'developer').model, models[0]);
    assert.equal(executionSettings(provider, 'qa').model, models[1]);
    const hard = executionSettings(provider, 'developer', { tier: 'hard', reason: 'Integration failure requires diagnosis' });
    assert.deepEqual([hard.model, hard.reasoning, hard.speed], [models[2], 'high', 'standard']);
    const override = executionSettings(provider, 'developer', { model: models[1], reasoning: 'low', reason: 'Bounded verification' });
    assert.deepEqual([override.model, override.reasoning], [models[1], 'low']);
    for (const request of [{ model: 'unknown' }, { speed: 'fast' }, { reasoning: 'ultra' }, { tier: 'hard' }, { history: 'whole chat' }, { reason: {} }]) {
      assert.throws(() => executionSettings(provider, 'developer', request));
    }
  }
});

test('Claude invocation applies the route and standard speed and denies native delegation', () => {
  const route = executionSettings('claude', 'developer');
  const args = buildClaudeArgs({ sessionId: '11111111-1111-4111-8111-111111111111', agent: 'developer', model: route.model, effort: route.reasoning });
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.equal(settings.fastMode, false);
  assert.ok(settings.permissions.deny.includes('Agent'));
  assert.ok(settings.permissions.deny.includes('Task'));
});

test('hierarchy has at most four managers and four children, with no third level or provider crossing', () => {
  const id = 'c-0000000000000001';
  const parent = manager(id);
  const child = brief('child', { parent: id });
  assert.equal(checkDelegation(child, { provider: 'codex', project: 'den', live: [parent] }), id);
  for (const live of [[], [manager(id, 'claude')], [manager(id, 'codex', 'other')], [{ ...parent, orchestration: child }], [{ ...parent, stopRequested: true }]]) {
    assert.throws(() => checkDelegation(child, { provider: 'codex', project: 'den', live }));
  }
  assert.throws(() => checkDelegation(brief('manager'), { provider: 'codex', project: 'den', live: Array.from({ length: 4 }, (_, i) => manager(`m${i}`)) }), /four managers/);
  const siblings = Array.from({ length: 4 }, (_, i) => ({ parent: id, orchestration: brief('child', { parent: id, files: [`${i}.mjs`], task: `work ${i}` }) }));
  assert.throws(() => checkDelegation(child, { provider: 'codex', project: 'den', live: [parent, ...siblings] }), /four children/);
  assert.throws(() => checkDelegation(child, { provider: 'codex', project: 'den', live: [parent, { parent: id, orchestration: child }] }), /separable/);
  assert.throws(() => delegation({ kind: 'child', parent: id, task: 'do stuff' }), /focused/);
});

test('the existing delivery repair limit pauses instead of requesting another implementer', async () => {
  const { nextStep, MAX_BOUNCES } = await import('../delivery/plan.mjs');
  const sha = 'b'.repeat(40);
  const job = { base: 'a'.repeat(40), candidate: { sha }, bounces: MAX_BOUNCES, evidence: {
    risk: { sha, floor: { roles: ['code-reviewer', 'qa'] } },
    review: { sha, verdict: 'bounce' }, qa: { sha, verdict: 'pass' },
  } };
  const step = nextStep(job);
  assert.equal(MAX_BOUNCES, 2);
  assert.deepEqual([step.kind, step.pause], ['pause', 'failed-twice']);
});
