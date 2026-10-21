// den-mvp/64: a meeting at Bao's table, in the real den with a mocked bridge. The seats wear their labels, Bao says
// what the meeting is doing, a landed take shows its claim, the meeting's runs lose their generic chips, and the pill
// opens the meeting in the side sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const REF = 'den-mvp/57-routing-rewrite-architecture';
const meeting = (state) => ({
  id: 'm-1', ref: REF, dir: '01-routing', title: '57: Routing rewrite architecture', state, pause: null, chair: 'orchestrator',
  seats: [
    { role: 'product', status: 'taken', takes: 1, reason: null },
    { role: 'architect', status: state === 'briefed' ? 'taken' : 'waiting', takes: state === 'briefed' ? 1 : 0, reason: null },
    { role: 'developer', status: state === 'briefed' ? 'taken' : 'waiting', takes: state === 'briefed' ? 1 : 0, reason: null },
  ],
  round: 'takes', brief: state === 'briefed' ? { version: 1, options: [{ key: 'A', title: 'Valhalla + Expo' }], recommended: 'A' } : null,
  decisions: [], thread: 0, live: state === 'running' ? { runId: 'c-1', role: 'architect', part: 'take' } : null, runs: 1, retired: false,
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

async function open(state) {
  const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch(buildLaunchOptions());
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  await lightenScene(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const m = meeting(state);
  const placement = { ref: REF, role: 'architect', state: 'working', lastEventAt: new Date().toISOString() };
  const snapshot = { schema: 1, seq: 1, tickets: [{ ref: REF, title: m.title, status: 'ready-for-agent' }], frontier: [], usage: null, requests: [], agents: [], placements: [placement], meetings: [m] };
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` }));
  await page.route('**/state', (r) => r.fulfill({ json: snapshot }));
  await page.route('**/metrics', (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.route((u) => u.pathname === '/session', (r) => r.fulfill({ json: { token: 't'.repeat(43) } }));
  await page.route((u) => u.pathname.startsWith('/meetings/'), (r) => r.fulfill({ json: { meeting: m, topic: 'Which router?', brief: null, thread: [], summary: null,
    takes: [{ role: 'product', n: 1, text: '# Take: product\n\n---\n\nClaim: Keep the two-week cut line.\nEvidence: the spec' }] } }));
  await page.goto(`${server.resolvedUrls.local[0]}#code=${'c'.repeat(43)}`);
  return { page, errors, close: async () => { await browser.close(); await server.close(); } };
}

test('a running meeting keeps progress and its take in the panel without claiming physical seats', { timeout: 90000 }, async () => {
  const t = await open('running');
  try {
    const { page } = t;
    const pill = page.locator('.meeting-pill');
    await pill.waitFor({ timeout: 60000 });
    assert.match(await pill.innerText(), /Meeting on 57 · 1 of 3 have spoken/);
    await page.waitForFunction(()=>{const b=document.querySelector('.den-entry button');return b&&b.getAttribute('aria-disabled')!=='true';},null,{timeout:60000});
    assert.equal(await page.locator('[data-seat]:visible').count(),0,'deferred seating has no invented visible seat labels');
    assert.equal(await page.locator(`.chip[data-ref="${REF}"]`).count(), 0, 'the meeting run remains in its panel without a generic chip');
    await pill.click();
    const meeting = page.locator('[data-sheet=side]');
    await meeting.waitFor();
    const take=meeting.locator('details[data-take="product"]');await take.locator('summary').click();
    assert.match(await take.innerText(),/Claim: Keep the two-week cut line\./,'the actual landed take remains readable');
    await page.locator('[data-rail=meetings]').click();
    const card = page.locator('[data-overlay=meetings]');
    await card.waitFor();
    await card.locator('[data-meeting=running]').waitFor();
    assert.equal(await meeting.count(), 1, 'opening the Meetings topic leaves the meeting side sheet open');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('a briefed meeting waits on the user and its panel take is keyboard accessible', { timeout: 90000 }, async () => {
  const t = await open('briefed');
  try {
    const { page } = t;
    const pill = page.locator('.meeting-pill');
    await pill.waitFor({ timeout: 60000 });
    assert.match(await pill.innerText(), /Meeting on 57 · waiting on you/);
    await pill.focus();
    await page.keyboard.press('Enter');
    const meeting = page.locator('[data-sheet=side]');
    await meeting.waitFor();
    await meeting.locator('details[data-take="product"] summary').focus();await page.keyboard.press('Enter');
    await meeting.locator('details[data-take="product"][open]').waitFor();
    assert.match(await meeting.locator('details[data-take="product"]').innerText(),/Claim: Keep the two-week cut line\./);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
