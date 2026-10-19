// den-mvp/12 (ADR 0026 decisions 6 to 9), in a real page: the den shows which build is live, a delivery that waits on its
// preview is opened, approved or declined from Needs you, a roll back names both builds, and an open tab is told when
// another build went live. The bridge is stubbed at the network; what it is sent is what the test checks.
// DEN_SHOTS=<dir> also saves screenshots (wide and 375px) for the user's visual check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const A = 'a1'.repeat(20), B = 'b2'.repeat(20), C = 'c3'.repeat(20), CAND = 'd4'.repeat(20);
const build = (more) => ({ live: { sha: B, at: '2026-10-13T14:05:00.000Z' }, previous: { sha: A }, rolledBack: null, ...more });
const waiting = (more) => ({
  id: 'd-1111111111111111', ref: 'fx/05-panel', title: '05: Slot panel <img src=x onerror=alert(1)>', state: 'paused', step: 'preview', live: null, base: 'e'.repeat(40), branch: 'den/fx/05-panel-01234567',
  pause: { kind: 'visual-verdict', reason: 'a UI change waits for your verdict on its preview', next: 'Open the preview. Approve it to merge it and put it live, or decline it with a note for the developer.' },
  candidate: { sha: CAND }, bounces: 0, declines: 1, ui: true, preview: { url: 'http://127.0.0.1:45123/', sha: CAND }, verdict: null, release: null,
  evidence: { qa: 'pass', security: null, risk: { clean: true, hits: 0, security: false, userMerge: false }, ci: null }, pr: null, runs: [], uncertain: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...more,
});
const snapshotOf = (more = {}) => ({
  schema: 1, seq: 1, frontier: [], usage: null, requests: [], sessions: [], agents: [], approvals: [], transcripts: {}, tickets: [], meetings: [],
  capacity: { max: 2, cap: 8, load: 0, live: 0, room: 2, refs: [], reserved: { bao: { max: 1, refs: [] }, scout: { max: 1, refs: [] } } },
  deliveries: [waiting()], build: build(), ...more,
});

// `frames` are change frames sent after the snapshot on the event stream.
async function open({ width = 1280, snapshot = snapshotOf(), frames = [], signedIn = true } = {}) {
  const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch(buildLaunchOptions());
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width, height: 900 } });
  await lightenScene(context);
  if (signedIn) await context.addInitScript(() => sessionStorage.setItem('den.session-token', 'tok-test-123'));
  const page = await context.newPage();
  const errors = [], posts = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const stream = [`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`, ...frames.map((f) => `event: change\ndata: ${JSON.stringify(f)}\n\n`)].join('');
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: stream }));
  await page.route('**/state', (r) => r.fulfill({ json: snapshot }));
  await page.route('**/metrics', (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  const taken = (r) => {
    posts.push({ path: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    return r.fulfill({ status: 200, json: { ok: true } });
  };
  await page.route('**/deliveries/**', taken);
  await page.route('**/build/rollback', taken);
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('[data-overlay=build]').waitFor();
  const close = async () => { await browser.close(); await server.close(); };
  return { page, errors, posts, close };
}
const shot = async (page, selector, name) => { if (process.env.DEN_SHOTS) await page.locator(selector).screenshot({ path: path.join(process.env.DEN_SHOTS, name) }); };
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test('the live build, a preview that waits for a verdict, and the way back', { timeout: 120000 }, async () => {
  const t = await open();
  try {
    const { page } = t;
    // Which build is live: the short commit and when it went live. No notice: this page is that build.
    const status = page.locator('[data-overlay=build]');
    assert.match(await status.innerText(), /^Den main @ b2b2b2b, live since .*2026/);
    assert.equal(await status.getByText('A new version is ready').count(), 0);
    assert.equal(await status.getByText(/behind main/).count(), 0);

    // The waiting preview, in Needs you: what it is, the link, what Approve covers, and the two answers.
    const needs = page.locator('[data-overlay=needs-you]');
    await needs.getByText('05-panel waits for your verdict on its preview').waitFor();
    const said = await needs.innerText();
    assert.match(said, /a UI change waits for your verdict on its preview[\s\S]*Approve covers the push, the pull request, the merge once the checks are green, and going live\./);
    assert.match(said, /declined by you 1 time/);
    const link = needs.getByRole('link', { name: 'Open the preview of 05-panel in a new tab' });
    assert.deepEqual([await link.getAttribute('href'), await link.getAttribute('target'), await link.getAttribute('rel')], ['http://127.0.0.1:45123/', '_blank', 'noreferrer noopener']);
    assert.equal(await page.locator('img[src="x"]').count(), 0, 'text from a ticket renders as text');
    await shot(page, '[data-overlay=needs-you]', 'build-needs-you.png');

    // Decline needs a note; the note goes with it.
    const decline = needs.getByRole('button', { name: 'Decline 05-panel and send it back to the developer' });
    assert.equal(await decline.isDisabled(), true);
    await needs.getByRole('button', { name: 'Approve: merge and go live' }).scrollIntoViewIfNeeded();
    await shot(page, '[data-overlay=needs-you]', 'build-needs-you-buttons.png');
    await needs.getByLabel('To decline, say what should change').fill('The card overlaps the door. Move it left.');
    await decline.click();
    await needs.getByRole('button', { name: 'Approve: merge and go live' }).click();

    // The way back names both builds.
    const back = status.getByRole('button', { name: 'Go back from build b2b2b2b to the previous build a1a1a1a' });
    assert.equal(await back.innerText(), 'Go back to the previous build');
    assert.match(await status.innerText(), /Live: b2b2b2b\. Previous: a1a1a1a\./);
    await back.click();
    await page.waitForFunction(() => !document.querySelector('[data-overlay=build] button[aria-busy]'));
    assert.deepEqual(t.posts, [
      { path: '/deliveries/d-1111111111111111/resume', body: { verdict: 'decline', note: 'The card overlaps the door. Move it left.' } },
      { path: '/deliveries/d-1111111111111111/resume', body: { verdict: 'approve' } },
      { path: '/build/rollback', body: { to: A } },
    ]);
    await shot(page, '[data-overlay=build]', 'build-status.png');
    assert.equal(await sideways(page), false);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('an open tab is told that a new version is ready, and reloads only on the button', { timeout: 120000 }, async () => {
  const rolled = build({ live: { sha: C, at: '2026-10-13T15:30:00.000Z' }, previous: { sha: B }, rolledBack: { sha: A, at: '2026-10-13T15:00:00.000Z' } });
  const t = await open({ frames: [{ seq: 2, type: 'build', build: rolled }] });
  try {
    const { page } = t;
    const status = page.locator('[data-overlay=build]');
    await status.getByText('A new version is ready.').waitFor();
    assert.match(await status.innerText(), /^Den main @ c3c3c3c, live since/);
    assert.match(await status.innerText(), /The live build is behind main: build a1a1a1a was rolled back\./);
    // The next approval says what going live brings with it.
    assert.match(await page.locator('[data-overlay=needs-you]').innerText(), /Going live will also bring back build a1a1a1a, which you rolled back\./);
    await shot(page, '[data-overlay=build]', 'build-new-version.png');
    let loads = 0;
    page.on('load', () => (loads += 1));
    await page.waitForTimeout(1500);
    assert.equal(loads, 0, 'the page never reloads by itself');
    await status.getByRole('button', { name: 'Reload the den to the new version' }).click();
    await page.waitForEvent('load');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('not signed in: the buttons are off and say why', { timeout: 120000 }, async () => {
  const t = await open({ signedIn: false });
  try {
    const { page } = t;
    const status = page.locator('[data-overlay=build]');
    assert.equal(await status.getByRole('button', { name: /Go back from build/ }).isDisabled(), true);
    assert.match(await status.innerText(), /Not signed in to steer/);
    const needs = page.locator('[data-overlay=needs-you]');
    await needs.getByText('05-panel waits for your verdict on its preview').waitFor();
    assert.equal(await needs.getByRole('button', { name: 'Approve: merge and go live' }).isDisabled(), true);
    assert.equal(await needs.getByRole('button', { name: /Decline 05-panel/ }).isDisabled(), true);
    assert.equal(await needs.getByLabel('To decline, say what should change').isDisabled(), true);
    assert.match(await needs.innerText(), /Not signed in to steer/);
    assert.equal(await needs.getByRole('link', { name: /Open the preview/ }).count(), 1, 'looking is not steering');
    assert.deepEqual(t.posts, []);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('at 375px: the build and the waiting preview fit, and the pauses after a merge read as sentences', { timeout: 120000 }, async () => {
  const stuck = [
    waiting({ id: 'd-2222222222222222', ref: 'fx/06-door', title: '06: Door', ui: true, preview: null, pause: { kind: 'needs-update', reason: 'the merged commit changes apps/bridge/server.mjs, which the running bridge (b2b2b2b2b2b2) does not have; the den must be updated before this change can go live', next: 'Update the den (npm run den:update), then Resume to put this change live.' } }),
    waiting({ id: 'd-3333333333333333', ref: 'fx/07-lamp', title: '07: Lamp', ui: true, preview: null, pause: { kind: 'go-live-failed', reason: 'the build failed (exit 1)', next: 'The merge stands and nothing went live. Resume to try again.' } }),
  ];
  const t = await open({ width: 375, snapshot: snapshotOf({ deliveries: [waiting(), ...stuck] }) });
  try {
    const { page } = t;
    const needs = page.locator('[data-overlay=needs-you]');
    if (!(await needs.getByText('05-panel waits for your verdict on its preview').isVisible())) await needs.locator('.card-toggle').click(); // closed on a phone until asked
    await needs.getByText('05-panel waits for your verdict on its preview').waitFor();
    assert.equal(await sideways(page), false);
    await shot(page, '[data-overlay=build]', 'build-status-375.png');
    await shot(page, '[data-overlay=needs-you]', 'build-needs-you-375.png');
    await needs.getByRole('button', { name: 'Approve: merge and go live' }).scrollIntoViewIfNeeded();
    await shot(page, '[data-overlay=needs-you]', 'build-needs-you-buttons-375.png');
    const all = await needs.innerText();
    assert.match(all, /06-door/);
    assert.match(all, /07-lamp/);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
