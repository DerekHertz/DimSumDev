#!/usr/bin/env node
// One-shot offline native diagnostic. Plan/check modes start no native or model process.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATE = '5c5ea4f0bc153154248ce401e7ac106358d79642';
const APPROVED_SLICE = 'den-agents-codex-task2';
const WORKTREE = '/home/dhertzell/dimsumden/.worktrees/standalone-codex';
const AGENTS = `${WORKTREE}/apps/bridge/agents`;
const CODEX_WRAPPER = '/home/dhertzell/.nvm/versions/node/v22.23.3/lib/node_modules/@openai/codex/bin/codex.js';
const NATIVE_HELPER = '/home/dhertzell/.nvm/versions/node/v22.23.3/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const PINS = Object.freeze({
  'codex-permissions-canary.mjs': 'd619386f77afd47a7b41c2461bc86cedefa9231c4eb43e62ad242b5b21ebfbec',
  'codex-permissions.mjs': '568847ad29fefb3be6118726d59dc0cf8876d858b7cfa60dd18269e9dacb08f0',
  'resource-group.mjs': 'becc8fb32a6ea75df1c0959443c06403b5721a781b5f43771e985f232e708c70',
  'scoped-writes.mjs': '36ffe39889b03ba85296f1888f06934c823e9208eadb775165fff5943cba65aa',
  'policy.mjs': 'ca9a02fedc61a3d8734e3b31de9d2eeb3944f00a51bac64646f288b39049b4bc',
  'limits.json': 'db0d3b0845d2bbf91690601675cd6a1337f205ad9c523e988ae7de782ac93884',
  'governance.json': '9ac7dc18159c7fd12b6677f6935ab480a66c434baed9f9e8999de240d51bef11',
});
const MAX_RECORDS = 64;
const MAX_OUTPUT_BYTES = 8192;
const EXCERPT_CHARS = 600;
const mode = process.argv[2] ?? '';
const FIXTURE_ROOT_RE = /^\/tmp\/den-codex-profile-task2-[A-Za-z0-9]+$/;

function canaryResultFailed(result, cleanupFailed = false) { return result?.ok !== true || cleanupFailed; }

async function settleRetainedGroups({ groups, add, fixtureRoot }) {
  let failed = false;
  for (const group of groups) {
    try { group.kill(); } catch { /* settlement below is still attempted once */ }
    let settled = false;
    try { settled = await group.settled(3000); } catch { settled = false; }
    if (settled) {
      add({ event: 'independent-group-settled', unit: group.unit, slice: APPROVED_SLICE, settled: true });
    } else {
      failed = true;
      add({ event: 'cleanup-uncertain', unit: group.unit, slice: APPROVED_SLICE, fixtureRoot, settled: false,
        remediation: 'stop; operator inspection required' });
    }
  }
  return { failed };
}

async function runSelfTest() {
  const positiveRecords = [];
  let positiveKills = 0, positiveSettles = 0;
  const positive = await settleRetainedGroups({ groups: [{ unit: 'fake-positive.scope', kill() { positiveKills += 1; }, async settled(ms) { assert.equal(ms, 3000); positiveSettles += 1; return true; } }],
    add: value => positiveRecords.push(value), fixtureRoot: null });
  assert.deepEqual(positive, { failed: false });
  assert.equal(positiveKills, 1); assert.equal(positiveSettles, 1);
  assert.deepEqual(positiveRecords[0], { event: 'independent-group-settled', unit: 'fake-positive.scope', slice: APPROVED_SLICE, settled: true });
  const uncertainRecords = [];
  let uncertainKills = 0, uncertainSettles = 0;
  const fixtureRoot = '/tmp/den-codex-profile-task2-selftest1';
  const uncertain = await settleRetainedGroups({ groups: [{ unit: 'fake-uncertain.scope', kill() { uncertainKills += 1; }, async settled(ms) { assert.equal(ms, 3000); uncertainSettles += 1; return false; } }],
    add: value => uncertainRecords.push(value), fixtureRoot });
  assert.deepEqual(uncertain, { failed: true });
  assert.equal(uncertainKills, 1); assert.equal(uncertainSettles, 1);
  assert.deepEqual(uncertainRecords[0], { event: 'cleanup-uncertain', unit: 'fake-uncertain.scope', slice: APPROVED_SLICE, fixtureRoot, settled: false, remediation: 'stop; operator inspection required' });
  assert.equal(canaryResultFailed({ ok: true }), false);
  assert.equal(canaryResultFailed({ ok: false }), true);
  assert.equal(canaryResultFailed(null), true);
  console.log(JSON.stringify({ mode: 'self-test', positive: 'passed', uncertain: 'passed', falseResultExitMapping: 'passed', nativeLaunches: 0 }));
}

function verifySourceClosure() {
  const execFileSync = childProcess.execFileSync;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['merge-base', '--is-ancestor', CANDIDATE, 'HEAD'], { cwd: WORKTREE, stdio: 'ignore' });
  const actual = {};
  for (const [name, expected] of Object.entries(PINS)) {
    const bytes = readFileSync(`${AGENTS}/${name}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    actual[name] = digest;
    if (digest !== expected) throw new Error(`source closure mismatch: ${name}`);
  }
  return { head, candidate: CANDIDATE, closure: actual };
}

if (mode === '--self-test') {
  await runSelfTest();
} else if (mode !== '--run-once') {
  if (mode === '--check-source') {
    console.log(JSON.stringify({ mode: 'source-check-only', ...verifySourceClosure(), startsNativeProcesses: false, preflightCleanupIndependentlyObserved: false }));
  } else if (mode === '' || mode === '--plan') {
    console.log(JSON.stringify({ mode: 'plan-only', candidate: CANDIDATE, startsNativeProcesses: false, preflightCleanupIndependentlyObserved: false,
      command: 'timeout --signal=TERM 90s node /tmp/codex-native-diagnostic.mjs --run-once' }));
  } else {
    throw new Error('usage: node /tmp/codex-native-diagnostic.mjs [--plan|--check-source|--self-test|--run-once]');
  }
} else {
  if (process.argv.length !== 3) throw new Error('usage: node /tmp/codex-native-diagnostic.mjs --run-once');
  const source = verifySourceClosure();
  const records = [];
  let dropped = 0;
  const add = (record) => {
    if (records.length >= MAX_RECORDS) { dropped += 1; return; }
    records.push(record);
  };
  const groups = new Set();
  let fixtureRoot = null;
  const controller = new AbortController();
  let abortReason = null;
  const requestAbort = (reason) => {
    if (!controller.signal.aborted) {
      abortReason = reason;
      add({ event: 'abort-requested', reason });
      controller.abort(reason);
    }
    for (const group of groups) group.kill();
  };
  const onTerm = () => requestAbort('SIGTERM');
  const onInt = () => requestAbort('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const timer = setTimeout(() => requestAbort('internal-timeout-55000ms'), 55_000);
  const began = Date.now();
  let failed = false;
  let result = null;
  try {
    // Imports happen only after candidate ancestry and every recursive data/source pin passed.
    const [{ runControlledOfflineCanary, CANARY_SLICE }, { createResourceLauncher }] = await Promise.all([
      import(pathToFileURL(`${AGENTS}/codex-permissions-canary.mjs`).href),
      import(pathToFileURL(`${AGENTS}/resource-group.mjs`).href),
    ]);
    if (CANARY_SLICE !== APPROVED_SLICE) throw new Error('trusted canary slice does not match approved slice');
    const launcher = createResourceLauncher({ slice: APPROVED_SLICE });
    const originalLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (request) => {
      const launched = await originalLaunch(request);
      const { child, group } = launched;
      groups.add(group);
      add({ event: 'resource-launched', executable: basename(String(request.bin)), pid: child.pid ?? null, unit: group.unit, slice: APPROVED_SLICE });
      let stdoutBytes = 0;
      let stderrBytes = 0;
      child.stdout?.on('data', chunk => { stdoutBytes += chunk.length; });
      child.stderr?.on('data', chunk => {
        stderrBytes += chunk.length;
      });
      child.once('error', error => add({ event: 'child-error', executable: basename(String(request.bin)), pid: child.pid ?? null, code: error?.code ?? null }));
      child.once('exit', (code, signal) => add({ event: 'child-exit', executable: basename(String(request.bin)), pid: child.pid ?? null, code, signal }));
      child.once('close', (code, signal) => add({ event: 'child-close', executable: basename(String(request.bin)), pid: child.pid ?? null,
        code, signal, stdoutBytes, stderrBytes }));
      // Covers cancellation while launcher.launch was pending and the group was not yet available to the signal handler.
      if (controller.signal.aborted) group.kill();
      return launched;
    };
    add({ event: 'begin', candidate: CANDIDATE, head: source.head, elapsedMs: 0 });
    result = await runControlledOfflineCanary({ codexBin: CODEX_WRAPPER, nativeHelper: NATIVE_HELPER,
      launcher, signal: controller.signal, timeoutMs: 30_000,
      observe: event => {
        if (event?.type === 'launched') {
          if (typeof event.root === 'string' && FIXTURE_ROOT_RE.test(event.root)) fixtureRoot = event.root;
          add({ event: 'canary-launched', unit: event.unit, slice: APPROVED_SLICE, fixtureRoot });
        }
        if (event?.type === 'cleanup') add({ event: 'canary-cleanup', unit: event.unit, settled: event.settled });
      } });
    failed = canaryResultFailed(result);
    const raw = result.rawOutput ?? {};
    add({ event: 'canary-result', elapsedMs: Date.now() - began, ok: result.ok === true, status: result.status ?? null,
      settled: result.settled ?? null, outputDrained: result.outputDrained ?? null, stdoutBytes: raw.stdoutBytes ?? null,
      stderrBytes: raw.stderrBytes ?? null, totalBytes: raw.totalBytes ?? null, stdoutExcerpt: failed ? String(raw.stdout ?? '').slice(0, EXCERPT_CHARS) : undefined,
      stderrExcerpt: failed ? String(raw.stderr ?? '').slice(0, EXCERPT_CHARS) : undefined, resultsPresent: Array.isArray(result.results),
      connections: result.connections ?? null, markersPreserved: result.markersPreserved ?? null, overflow: result.overflow ?? null });
  } catch (error) {
    failed = true;
    add({ event: 'wrapper-error', elapsedMs: Date.now() - began, name: String(error?.name ?? 'Error').slice(0, 80),
      code: error?.code ?? null, message: String(error?.message ?? '').slice(0, EXCERPT_CHARS) });
  } finally {
    clearTimeout(timer);
  }
  if (abortReason) failed = true;

  // Preflight's internal probe cleanup is not independently observed by this wrapper.
  // For each exact returned group, settleRetainedGroups performs one kill and one bounded check.
  const cleanup = await settleRetainedGroups({ groups, add, fixtureRoot });
  if (canaryResultFailed(result, cleanup.failed) || abortReason) failed = true;

  // Emit a bounded JSON record. Output excerpts contain only the canary's dummy-fixture run.
  let payload = { candidate: CANDIDATE, head: source.head, elapsedMs: Date.now() - began, failed, abortReason,
    preflightCleanupIndependentlyObserved: false, records, droppedRecords: dropped, telemetryBytes: 0 };
  let encoded;
  for (;;) {
    payload.telemetryBytes = 0;
    encoded = JSON.stringify(payload);
    payload.telemetryBytes = Buffer.byteLength(encoded);
    encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) <= MAX_OUTPUT_BYTES || records.length === 0) break;
    records.pop();
    dropped += 1;
    payload.droppedRecords = dropped;
  }
  console.log(encoded);
  process.off('SIGTERM', onTerm);
  process.off('SIGINT', onInt);
  if (failed) process.exitCode = 1;
}
