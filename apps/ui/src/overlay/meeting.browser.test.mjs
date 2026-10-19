// den-mvp outcome 4, in a real page: the Meetings card. Setup sends the question and the roles picked; a meeting's row
// shows each seat and the chair; the brief opens with the chair's text shown as text, the options to choose from, the
// takes and the follow-ups; choosing an option and asking a follow-up send exactly that. The bridge is stubbed at the network.
// DEN_SHOTS=<dir> also saves screenshots of the card (wide and 375px) for the user's visual check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const BRIEF = ['# Question', 'One log per job, or one for all? <img src=x onerror="window.__hit = 1">', '', '## Option A: One log for all jobs', 'Benefit: one file to replay', 'Cost: it grows', 'Caveat: none', 'Tasks: 1', 'Backed by: architect', '',
  '## Option B: One log per job', 'Benefit: small files', 'Cost: more files to find', 'Caveat: cleanup', 'Tasks: 3', 'Backed by: qa', '', 'RECOMMENDED: A', 'It is what the code does today.', '', '## Only you can answer', '- How long must a log be kept?'].join('\n');
const briefed = {
  id: 'm-00000000000000b1', ref: 'den/07-meeting', dir: '01-meeting', title: 'Meeting: one log per job, or one for all?', state: 'briefed', pause: null, chair: 'orchestrator',
  seats: [{ role: 'architect', status: 'taken', takes: 1, reason: null }, { role: 'qa', status: 'taken', takes: 1, reason: null }, { role: 'security', status: 'declined', takes: 0, reason: 'nothing here touches access or secrets' }, { role: 'designer', status: 'failed', takes: 0, reason: 'the run failed' }],
  round: null, brief: { version: 1, options: [{ key: 'A', title: 'One log for all jobs' }, { key: 'B', title: 'One log per job' }], recommended: 'A' },
  decisions: [], thread: 2, live: null, runs: 5, retired: false, rejoinUntil: null, startedAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:09:00.000Z',
};
const running = {
  ...briefed, id: 'm-00000000000000a1', ref: 'den/09-meeting', dir: '02-meeting', title: 'Meeting: should the scout get a second connection?', state: 'running',
  seats: [{ role: 'product', status: 'taken', takes: 1, reason: null }, { role: 'security', status: 'waiting', takes: 0, reason: null }, { role: 'developer', status: 'waiting', takes: 0, reason: null }],
  round: 'brief', brief: null, thread: 0, live: { runId: 'c-00000000000000aa', role: 'security', part: 'take' },
};
const snapshot = {
  schema: 1, seq: 1, frontier: [], usage: { fiveHour: 41, weekly: 30, sampledAt: new Date().toISOString() }, requests: [], sessions: [], agents: [], approvals: [], transcripts: {}, tickets: [], deliveries: [],
  meetings: [briefed, running],
  capacity: { max: 2, cap: 8, load: 0, live: 0, room: 2, refs: [], reserved: { bao: { max: 1, refs: [] }, scout: { max: 1, refs: [] } } },
};
const detail = {
  meeting: briefed, topic: 'Should the den keep one log per job, or one log for all jobs?\nI care most about restarts.', brief: BRIEF, summary: null,
  takes: [{ role: 'architect', n: 1, text: 'Claim: one log is enough\nEvidence: jobs.mjs\nConfidence: fairly sure' }, { role: 'qa', n: 1, text: 'Claim: per-job logs are easier to test\nConfidence: unsure' }],
  thread: [{ ts: null, from: 'user', text: 'What does option B cost at restart?' }, { ts: null, from: 'chair', text: 'One replay per job.' }],
};

async function open({ width = 1280 } = {}) {
  const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch(buildLaunchOptions());
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width, height: 1000 } });
  await lightenScene(context);
  await context.addInitScript(() => sessionStorage.setItem('den.session-token', 'tok-test-123'));
  const page = await context.newPage();
  const errors = [];
  const posts = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` }));
  await page.route('**/state', (r) => r.fulfill({ json: snapshot }));
  await page.route('**/metrics', (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  // By path, not by a glob: the page also loads the bridge's meetings/types.mjs as a module, and that is not the bridge's route.
  await page.route((url) => url.pathname === '/meetings' || url.pathname.startsWith('/meetings/'), (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (req.method() === 'GET') return r.fulfill({ json: detail });
    posts.push([url.pathname, req.postDataJSON(), req.headers().authorization]);
    return r.fulfill({ status: url.pathname === '/meetings' ? 201 : 202, json: { meeting: briefed } });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => document.querySelector('.den-entry button')?.getAttribute('aria-disabled') !== 'true');
  const close = async () => { await browser.close(); await server.close(); };
  return { page, errors, posts, close };
}
const shot = async (page, name) => { if (process.env.DEN_SHOTS) await page.locator('[data-overlay=meetings]').screenshot({ path: path.join(process.env.DEN_SHOTS, name) }); };

test('the meetings card: progress for each seat, the brief as text, a choice and a follow-up', { timeout: 90000 }, async () => {
  const t = await open();
  try {
    const { page } = t;
    const card = page.locator('[data-overlay=meetings]');
    const toggle = card.locator('.card-toggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.match(await toggle.innerText(), /1 running/);
    const live = await card.locator('[data-meeting=running]').innerText();
    assert.match(live, /Security is giving its take[\s\S]*●\s*product gave its take[\s\S]*○\s*security giving its take now[\s\S]*○\s*developer not asked yet[\s\S]*○\s*Bao chairs: after the takes/i);
    const row = card.locator('[data-meeting=briefed]');
    assert.match(await row.innerText(), /The brief is ready: 2 options, A recommended\. The choice is yours\.[\s\S]*–\s*security declined: nothing here touches access or secrets[\s\S]*▲\s*designer no take: the run failed/i);
    await shot(page, 'meetings-progress-wide.png');

    await row.getByRole('button', { name: 'Open the brief' }).click();
    await row.locator('[data-meeting-brief]').waitFor();
    const brief = await row.locator('[data-meeting-brief]').innerText();
    assert.match(brief, /## Option B: One log per job[\s\S]*RECOMMENDED: A/);
    assert.match(brief, /<img src=x onerror=/, 'the chair\'s text is shown as text');
    assert.equal(await page.evaluate(() => window.__hit ?? 0), 0, 'nothing in the brief ran');
    assert.equal(await row.locator('img').count(), 0);
    assert.match(await row.innerText(), /I care most about restarts\.[\s\S]*A One log for all jobs · Bao recommends this[\s\S]*Nothing is built yet\.[\s\S]*You: What does option B cost at restart\?[\s\S]*Bao: One replay per job\./);
    await row.locator('details', { hasText: 'architect' }).locator('summary').click();
    assert.match(await row.locator('details', { hasText: 'architect' }).innerText(), /Claim: one log is enough/);
    await shot(page, 'meetings-brief-wide.png');

    await row.getByRole('button', { name: 'Choose option B: One log per job' }).click();
    await page.waitForFunction(() => true);
    await row.getByLabel('Ask a follow-up').fill('And with ten jobs?');
    await row.getByLabel('Ask again first').selectOption('qa');
    assert.match(await row.innerText(), /2 runs: qa gives a new take, then Bao answers\./);
    await row.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-meeting=briefed] textarea')?.value === '');
    assert.deepEqual(t.posts.map((p) => [p[0], p[1]]), [
      [`/meetings/${briefed.id}/decide`, { option: 'B' }],
      [`/meetings/${briefed.id}/ask`, { text: 'And with ten jobs?', reask: 'qa' }],
    ]);
    assert.ok(t.posts.every((p) => p[2] === 'Bearer tok-test-123'));
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('the meetings card: setup sends the question and the roles picked, and says what it will use', { timeout: 90000 }, async () => {
  const t = await open();
  try {
    const { page } = t;
    const card = page.locator('[data-overlay=meetings]');
    await card.locator('.card-toggle').click();
    const start = card.getByRole('button', { name: 'Start meeting' });
    assert.equal(await start.isDisabled(), true);
    assert.match(await card.locator('#meeting-reason').innerText(), /Write the question first\./);
    await card.getByLabel('The question').fill('Should the scout get a second connection?');
    assert.match(await card.locator('#meeting-reason').innerText(), /Pick at least one role\./);
    await card.getByLabel('security').check();
    await card.getByLabel('architect').check();
    assert.match(await card.locator('#meeting-cost').innerText(), /3 runs: 2 takes, one at a time, then Bao's brief\. Five-hour usage is 41%\./);
    assert.equal(await card.getByRole('checkbox').count(), 11, 'the scout and Bao are not seats; ADR 0029 adds four specialists');
    await start.click();
    await page.waitForFunction(() => document.querySelector('#meeting-topic')?.value === '');
    assert.deepEqual(t.posts.map((p) => [p[0], p[1]]), [['/meetings', { topic: 'Should the scout get a second connection?', roles: ['architect', 'security'] }]]);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('the meetings card at 375px fits the screen, and Needs you opens a ready brief', { timeout: 90000 }, async () => {
  const t = await open({ width: 375 });
  try {
    const { page } = t;
    const needs = page.locator('[data-overlay=needs-you]');
    await needs.locator('.card-toggle').click();
    assert.match(await needs.innerText(), /A meeting's brief is ready[\s\S]*The brief is ready: 2 options, A recommended/);
    await needs.getByRole('button', { name: 'Open the brief' }).click();
    const card = page.locator('[data-overlay=meetings]');
    await card.locator('[data-meeting-brief]').waitFor();
    assert.equal(await card.locator('.card-toggle').getAttribute('aria-expanded'), 'true');
    const box = await card.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 375, `the card is inside the screen (${box.x} + ${box.width})`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    await shot(page, 'meetings-375.png');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
