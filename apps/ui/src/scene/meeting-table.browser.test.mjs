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

test('a running meeting: seat labels, Bao listening, the claim, no generic chip, and the pill opens the meeting', { timeout: 90000 }, async () => {
  const t = await open('running');
  try {
    const { page } = t;
    const pill = page.locator('.meeting-pill');
    await pill.waitFor({ timeout: 60000 });
    assert.match(await pill.innerText(), /Meeting on 57 · 1 of 3 have spoken/);
    const seat = (key) => page.locator(`[data-seat="${key}"]`);
    await page.waitForFunction(() => document.querySelector('[data-seat="product"]')?.style.visibility === 'visible', null, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('[data-seat="product"] .meeting-claim')?.textContent === 'Keep the two-week cut line.', null, { timeout: 20000 });
    assert.match(await seat('product').getAttribute('aria-label'), /product: Said its piece\. Keep the two-week cut line\./, 'the landed take shows its claim');
    assert.match(await seat('architect').innerText(), /Thinking/);
    assert.match(await seat('developer').innerText(), /Waiting to speak/);
    assert.match(await seat('orchestrator').innerText(), /Bao · Listening/);
    assert.equal(await page.locator(`.chip[data-ref="${REF}"]`).count(), 0, 'the meeting run wears its seat label, not a chip');
    await pill.click();
    const meeting = page.locator('[data-sheet=side]');
    await meeting.waitFor();
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

test('a briefed meeting waits on the user, and a seat opens its own take', { timeout: 90000 }, async () => {
  const t = await open('briefed');
  try {
    const { page } = t;
    const pill = page.locator('.meeting-pill');
    await pill.waitFor({ timeout: 60000 });
    assert.match(await pill.innerText(), /Meeting on 57 · waiting on you/);
    await page.waitForFunction(() => document.querySelector('[data-seat="orchestrator"]')?.style.visibility === 'visible', null, { timeout: 60000 });
    assert.match(await page.locator('[data-seat="orchestrator"]').innerText(), /Bao · Brief ready · your choice/);
    await page.locator('[data-seat="product"]').focus();
    await page.keyboard.press('Enter');
    const meeting = page.locator('[data-sheet=side]');
    await meeting.waitFor();
    await meeting.locator('details[data-take="product"][open]').waitFor();
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
