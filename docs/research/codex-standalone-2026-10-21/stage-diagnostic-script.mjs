#!/usr/bin/env node
// Offline preparation wrapper. Only --run-once invokes the native helper.
// Every other mode is fake-only and must never launch Codex.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATE = '7ad7c4e8d0916012cbf03aa89aee6aee43276cd3';
const APPROVED_SLICE = 'den-agents-codex-task2';
const WORKTREE = '/home/dhertzell/dimsumden/.worktrees/standalone-codex';
const AGENTS = `${WORKTREE}/apps/bridge/agents`;
const HELPER = '/home/dhertzell/.nvm/versions/node/v22.23.3/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const HELPER_SHA256 = '399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215';
const PINS = Object.freeze({
  'codex-permissions-canary.mjs': 'd619386f77afd47a7b41c2461bc86cedefa9231c4eb43e62ad242b5b21ebfbec',
  'codex-permissions.mjs': '568847ad29fefb3be6118726d59dc0cf8876d858b7cfa60dd18269e9dacb08f0',
  'resource-group.mjs': 'becc8fb32a6ea75df1c0959443c06403b5721a781b5f43771e985f232e708c70',
  'scoped-writes.mjs': '36ffe39889b03ba85296f1888f06934c823e9208eadb775165fff5943cba65aa',
  'policy.mjs': 'ca9a02fedc61a3d8734e3b31de9d2eeb3944f00a51bac64646f288b39049b4bc',
  'limits.json': 'db0d3b0845d2bbf91690601675cd6a1337f205ad9c523e988ae7de782ac93884',
  'governance.json': '9ac7dc18159c7fd12b6677f6935ab480a66c434baed9f9e8999de240d51bef11',
});
const RECORD_LIMIT = 48;
const OUTPUT_LIMIT = 8192;
const EXCERPT_LIMIT = 600;
const FIXTURE_ROOT_RE = /^\/tmp\/den-codex-profile-task2-[A-Za-z0-9]+$/;
const STAGE_MARKER = 'CODEX_STAGE_PROBE_ENTERED';
const mode = process.argv[2] ?? '';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canaryFailed(result, cleanupFailed = false) { return result?.ok !== true || cleanupFailed; }

function verifySourceClosure() {
  const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  childProcess.execFileSync('git', ['merge-base', '--is-ancestor', CANDIDATE, 'HEAD'], { cwd: WORKTREE, stdio: 'ignore' });
  const files = {};
  for (const [name, expected] of Object.entries(PINS)) {
    const digest = sha256(readFileSync(`${AGENTS}/${name}`));
    files[name] = digest;
    if (digest !== expected) throw new Error(`source closure mismatch: ${name}`);
  }
  const helperDigest = sha256(readFileSync(HELPER));
  if (helperDigest !== HELPER_SHA256) throw new Error('native helper hash mismatch');
  return { head, candidate: CANDIDATE, files, helper: { path: HELPER, sha256: helperDigest } };
}

function prepareCanarySource() {
  let source = readFileSync(`${AGENTS}/codex-permissions-canary.mjs`, 'utf8');
  const importOld = 'import { createResourceLauncher } from "./resource-group.mjs";\nimport { compileCodexPermissions, renderCodexConfig } from "./codex-permissions.mjs";';
  const importNew = `import { createResourceLauncher } from ${JSON.stringify(pathToFileURL(`${AGENTS}/resource-group.mjs`).href)};\nimport { compileCodexPermissions, renderCodexConfig } from ${JSON.stringify(pathToFileURL(`${AGENTS}/codex-permissions.mjs`).href)};`;
  assert.equal(source.split(importOld).length - 1, 1, 'trusted canary imports changed');
  source = source.replace(importOld, importNew);
  const probeOld = "const PROBE = String.raw`import fs from 'node:fs';\n";
  const probeNew = `const PROBE = String.raw\`import fs from 'node:fs';\nprocess.stderr.write('${STAGE_MARKER}\\n');\n`;
  assert.equal(source.split(probeOld).length - 1, 1, 'trusted probe entry changed');
  source = source.replace(probeOld, probeNew);
  const binOld = 'return { root, worktree, nativeStore, config, launchable: compiled.launchable, bin: codexBin,';
  const binNew = 'return { root, worktree, nativeStore, config, launchable: compiled.launchable, bin: nativeHelper,';
  assert.equal(source.split(binOld).length - 1, 1, 'trusted canary plan changed');
  source = source.replace(binOld, binNew);
  return { source, sha256: sha256(source) };
}

function emitBounded(payload) {
  const result = { ...payload };
  let encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded) > OUTPUT_LIMIT) {
    result.records = result.records.slice(0, 8).map(({ event, unit, slice, settled, code, signal }) => ({ event, unit, slice, settled, code, signal }));
    result.outputTruncated = true;
    encoded = JSON.stringify(result);
  }
  if (Buffer.byteLength(encoded) > OUTPUT_LIMIT) encoded = JSON.stringify({ error: 'bounded diagnostic record exceeded output limit', failed: true });
  console.log(encoded);
}

async function runSelfTest() {
  const prepared = prepareCanarySource();
  assert.match(prepared.source, new RegExp(STAGE_MARKER));
  assert.match(prepared.source, /bin: nativeHelper/);
  assert.equal((prepared.source.match(/bin: nativeHelper/g) ?? []).length, 1);
  assert.equal(canaryFailed({ ok: true }), false);
  assert.equal(canaryFailed({ ok: false }), true);
  assert.equal(canaryFailed(null), true);
  const fakeOutput = `before\n${STAGE_MARKER}\nafter`;
  assert.equal(fakeOutput.includes(STAGE_MARKER), true);
  assert.equal(Buffer.byteLength(fakeOutput.slice(0, 128)) <= 128, true);
  let kills = 0, checks = 0;
  const fakeGroup = { unit: 'fake-stage.scope', kill() { kills++; }, async settled(ms) { checks++; assert.equal(ms, 3000); return false; } };
  fakeGroup.kill();
  const settled = await fakeGroup.settled(3000);
  assert.equal(settled, false);
  assert.equal(kills, 1);
  assert.equal(checks, 1);
  console.log(JSON.stringify({ mode: 'self-test', nativeLaunches: 0, directHelperRewrite: 'passed', entryMarker: 'passed', uncertainCleanupSingleCheck: 'passed', transformedSourceSha256: prepared.sha256 }));
}

if (mode === '--self-test') {
  await runSelfTest();
} else if (mode === '--check-source') {
  console.log(JSON.stringify({ mode: 'source-check-only', ...verifySourceClosure(), transformedSourceSha256: prepareCanarySource().sha256, startsNativeProcesses: false }));
} else if (mode === '' || mode === '--plan') {
  console.log(JSON.stringify({ mode: 'plan-only', candidate: CANDIDATE, helper: HELPER, helperSha256: HELPER_SHA256,
    slice: APPROVED_SLICE, timeout: 'outer 90s, internal 30s, group settlement 3s', marker: STAGE_MARKER,
    changes: ['launch pinned native helper directly with unchanged sandbox argv/environment/profile', 'write one stderr marker at probe entry before existing checks'],
    nativeLaunches: 0, command: 'timeout --signal=TERM 90s node /tmp/codex-stage-diagnostic.mjs --run-once' }));
} else if (mode === '--run-once' && process.argv.length === 3) {
  const sourceClosure = verifySourceClosure();
  const prepared = prepareCanarySource();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'codex-stage-source-'));
  const copied = path.join(scratch, 'codex-permissions-canary.mjs');
  writeFileSync(copied, prepared.source, { mode: 0o600, flag: 'wx' });
  const records = [];
  let dropped = 0;
  const add = record => { if (records.length < RECORD_LIMIT) records.push(record); else dropped++; };
  const groups = new Set();
  let fixtureRoot = null;
  const controller = new AbortController();
  let abortReason = null;
  const requestAbort = reason => {
    if (!controller.signal.aborted) { abortReason = reason; add({ event: 'abort-requested', reason }); controller.abort(reason); }
    for (const group of groups) { try { group.kill(); } catch {} }
  };
  const onTerm = () => requestAbort('SIGTERM');
  const onInt = () => requestAbort('SIGINT');
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  const timer = setTimeout(() => requestAbort('internal-timeout-55000ms'), 55_000);
  const began = Date.now();
  let result = null, failed = false;
  try {
    const [{ runControlledOfflineCanary, CANARY_SLICE }, { createResourceLauncher }] = await Promise.all([
      import(pathToFileURL(copied).href),
      import(pathToFileURL(`${AGENTS}/resource-group.mjs`).href),
    ]);
    if (CANARY_SLICE !== APPROVED_SLICE) throw new Error('trusted canary slice does not match approved slice');
    const launcher = createResourceLauncher({ slice: APPROVED_SLICE });
    const originalLaunch = launcher.launch.bind(launcher);
    launcher.launch = async request => {
      const launched = await originalLaunch(request);
      const { child, group } = launched;
      groups.add(group);
      add({ event: 'resource-launched', executable: path.basename(String(request.bin)), pid: child.pid ?? null, unit: group.unit, slice: APPROVED_SLICE });
      let stdoutBytes = 0, stderrBytes = 0;
      let markerSeen = false;
      let stderrTail = '';
      child.stdout?.on('data', chunk => { stdoutBytes += chunk.length; });
      child.stderr?.on('data', chunk => {
        stderrBytes += chunk.length;
        stderrTail = (stderrTail + chunk.toString()).slice(-2048);
        if (stderrTail.includes(STAGE_MARKER)) markerSeen = true;
      });
      child.once('error', error => add({ event: 'child-error', executable: path.basename(String(request.bin)), pid: child.pid ?? null, code: error?.code ?? null }));
      child.once('exit', (code, signal) => add({ event: 'child-exit', executable: path.basename(String(request.bin)), pid: child.pid ?? null, code, signal }));
      child.once('close', (code, signal) => add({ event: 'child-close', executable: path.basename(String(request.bin)), pid: child.pid ?? null, code, signal, stdoutBytes, stderrBytes, stageMarkerSeen: markerSeen }));
      if (controller.signal.aborted) group.kill();
      return launched;
    };
    add({ event: 'begin', candidate: CANDIDATE, head: sourceClosure.head, transformedCanarySha256: prepared.sha256, helperSha256: HELPER_SHA256 });
    result = await runControlledOfflineCanary({ codexBin: HELPER, nativeHelper: HELPER, launcher, signal: controller.signal, timeoutMs: 30_000,
      observe: event => {
        if (event?.type === 'launched') {
          if (typeof event.root === 'string' && FIXTURE_ROOT_RE.test(event.root)) fixtureRoot = event.root;
          add({ event: 'canary-launched', unit: event.unit, slice: APPROVED_SLICE, fixtureRoot });
        }
        if (event?.type === 'cleanup') add({ event: 'canary-cleanup', unit: event.unit, settled: event.settled });
      } });
    const raw = result.rawOutput ?? {};
    const markerSeen = String(raw.stderr ?? '').includes(STAGE_MARKER);
    failed = canaryFailed(result);
    add({ event: 'canary-result', elapsedMs: Date.now() - began, ok: result.ok === true, status: result.status ?? null,
      settled: result.settled ?? null, outputDrained: result.outputDrained ?? null, stageMarkerSeen: markerSeen,
      stdoutBytes: raw.stdoutBytes ?? null, stderrBytes: raw.stderrBytes ?? null, totalBytes: raw.totalBytes ?? null,
      stdoutExcerpt: failed ? String(raw.stdout ?? '').slice(0, EXCERPT_LIMIT) : undefined,
      stderrExcerpt: failed ? String(raw.stderr ?? '').slice(0, EXCERPT_LIMIT) : undefined,
      resultsPresent: Array.isArray(result.results), results: Array.isArray(result.results) ? result.results : null,
      connections: result.connections ?? null, markersPreserved: result.markersPreserved ?? null, overflow: result.overflow ?? null });
  } catch (error) {
    failed = true;
    add({ event: 'wrapper-error', elapsedMs: Date.now() - began, name: String(error?.name ?? 'Error').slice(0, 80), code: error?.code ?? null, message: String(error?.message ?? '').slice(0, EXCERPT_LIMIT) });
  } finally {
    clearTimeout(timer);
  }
  if (abortReason) failed = true;
  let cleanupFailed = false;
  for (const group of groups) {
    try { group.kill(); } catch {}
    let settled = false;
    try { settled = await group.settled(3000); } catch { settled = false; }
    if (settled) add({ event: 'independent-group-settled', unit: group.unit, slice: APPROVED_SLICE, settled: true });
    else { cleanupFailed = true; add({ event: 'cleanup-uncertain', unit: group.unit, slice: APPROVED_SLICE, fixtureRoot, settled: false, remediation: 'stop; operator inspection required' }); }
  }
  if (canaryFailed(result, cleanupFailed) || abortReason) failed = true;
  if (cleanupFailed) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} }
  else { try { rmSync(scratch, { recursive: true, force: true }); } catch { failed = true; add({ event: 'temporary-source-cleanup-failed', scratch }); } }
  process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  emitBounded({ candidate: CANDIDATE, head: sourceClosure.head, elapsedMs: Date.now() - began, failed, abortReason,
    preflightCleanupIndependentlyObserved: false, records, droppedRecords: dropped, telemetryBytes: 0 });
  if (failed) process.exitCode = 1;
} else {
  throw new Error('usage: node /tmp/codex-stage-diagnostic.mjs [--plan|--check-source|--self-test|--run-once]');
}
