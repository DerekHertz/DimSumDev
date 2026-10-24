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
  schema: 2, project: 'den', moderator: 'bao', topic: 'Which router?', depth: 'quick', budget: 4, spent: 0, estimatedSpent: 0,
  questions: [], proposals: [], summary: '', events: [],
  id: 'm-1', ref: REF, title: '57: Routing rewrite architecture', state, chair: 'chief-of-staff',
  seats: [
    { role: 'product', status: 'taken', takes: 1, reason: null },
    { role: 'architect', status: state === 'waiting-decision' ? 'taken' : 'waiting', takes: state === 'waiting-decision' ? 1 : 0, reason: null },
    { role: 'developer', status: state === 'waiting-decision' ? 'taken' : 'waiting', takes: state === 'waiting-decision' ? 1 : 0, reason: null },
  ],
  round: 1,
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
  const events = [{ id: 'e-product', actor: 'product', kind: 'message', round: 1, at: m.startedAt, text: 'Claim: Keep the two-week cut line.\nEvidence: the spec', cost: 0, runId: 'c-product' }];
  await page.route((u) => u.pathname.startsWith('/meetings/'), (r) => r.fulfill({ json: { meeting: m, events, takes: [], thread: [] } }));
  await page.goto(`${server.resolvedUrls.local[0]}#code=${'c'.repeat(43)}`);
  return { page, errors, close: async () => { await browser.close(); await server.close(); } };
}

test('a running meeting shows its actual seated participants while keeping progress and takes in the panel', { timeout: 90000 }, async () => {
  const t = await open('running');
  try {
    const { page } = t;
    const pill = page.locator('.meeting-pill');
    await pill.waitFor({ timeout: 60000 });
    assert.match(await pill.innerText(), /Meeting · In discussion/);
    await page.waitForFunction(()=>{const b=document.querySelector('.den-entry button');return b&&b.getAttribute('aria-disabled')!=='true';},null,{timeout:60000});
    const expectedSeats=[...meeting('running').seats.map(seat=>seat.role),'orchestrator'].sort();
    await page.waitForFunction(expected=>{
      const visible=[...document.querySelectorAll('[data-seat]')].filter(node=>getComputedStyle(node).visibility==='visible').map(node=>node.dataset.seat).sort();
      return JSON.stringify(visible)===JSON.stringify(expected);
    },expectedSeats,{timeout:15000});
    assert.deepEqual(await page.locator('[data-seat]:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.seat).sort()),expectedSeats,'each configured participant and the actual Bao chair has one arrived-body label');
    assert.equal(await page.locator(`.chip[data-ref="${REF}"]`).count(), 0, 'the meeting run remains in its panel without a generic chip');
    await pill.click();
    const meetingPanel = page.locator('[data-sheet=side]');
    await meetingPanel.waitFor();
    const take=meetingPanel.locator('article[data-take="product"]');await take.locator('summary').click();
    assert.match(await take.innerText(),/Claim: Keep the two-week cut line\./,'the actual landed take remains readable');
    await page.locator('[data-rail=meetings]').click();
    const card = page.locator('[data-overlay=meetings]');
    await card.waitFor();
    await card.locator('[data-meeting=running]').waitFor();
    assert.equal(await meetingPanel.count(), 1, 'opening the Meetings topic leaves the meeting side sheet open');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('a decision meeting waits on the user and its panel take is keyboard accessible', { timeout: 90000 }, async () => {
  const t = await open('waiting-decision');
  try {
    const { page } = t;
    const pill = page.locator('.meeting-pill');
    await pill.waitFor({ timeout: 60000 });
    assert.match(await pill.innerText(), /Meeting · Waiting on your decision/);
    await pill.focus();
    await page.keyboard.press('Enter');
    const meeting = page.locator('[data-sheet=side]');
    await meeting.waitFor();
    await meeting.locator('article[data-take="product"] summary').focus();await page.keyboard.press('Enter');
    await meeting.locator('article[data-take="product"] details[open]').waitFor();
    assert.match(await meeting.locator('article[data-take="product"]').innerText(),/Claim: Keep the two-week cut line\./);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
