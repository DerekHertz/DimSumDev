import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const id = 'm-00000000000000b1';
const source = 'e-0000000000000001';
const stamp = '2026-10-23T20:00:00Z';
const meeting = () => ({ schema: 2, id, ref: null, project: 'den', title: 'Recovery discussion', moderator: 'jiao', state: 'waiting-decision', depth: 'dig-in', round: 2, budget: 4, spent: 0.25, estimatedSpent: 0.4, seats: [{ role: 'architect', active: true, status: 'taken', takes: 1 }, { role: 'qa', active: true, status: 'taken', takes: 1 }], questions: [{ id: 'q-one', question: 'One journal or many?', options: [{ key: 'A', title: 'One journal', tradeoff: 'Simple replay; file grows' }, { key: 'B', title: 'Many journals', tradeoff: 'Small files; discovery costs' }], recommended: 'A', sourceIds: [source], required: ['architect'], answer: null }], decisions: [], proposals: [], summary: '', live: null, events: [{ id: source, kind: 'message', actor: 'architect', round: 1, at: stamp, text: 'Claim: One journal\nEvidence: recovery.mjs\nConfidence: unsure\n<img src=x onerror="window.__hit=1">', runId: 'c-0000000000000001', cost: null, estimate: 0.4, tools: [] }], startedAt: stamp, updatedAt: stamp });

async function open(width = 1440, colorScheme = 'light', twoRecords = false) {
  const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch(buildLaunchOptions());
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', colorScheme });
  await lightenScene(context);
  await context.addInitScript(() => sessionStorage.setItem('den.session-token', 'fixture-session'));
  const page = await context.newPage(), posts = [], errors = [], m = meeting();
  m.activity = [{ id: 'activity-one', kind: 'message', actor: 'architect', at: stamp, round: 1 }, { id: 'activity-two', kind: 'status', actor: 'jiao', at: stamp, state: 'waiting-decision' }];
  const other = { ...meeting(), id: 'm-00000000000000b2', title: 'Second private meeting', state: 'paused', events: [], questions: [] };
  const records = twoRecords ? [m, other] : [m];
  page.on('pageerror', e => errors.push(e.message));
  const snapshot = { schema: 1, seq: 1, frontier: [], tickets: [], requests: [], usage: null, agents: [], approvals: [], deliveries: [], meetings: records };
  await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` }));
  await page.route('**/state', r => r.fulfill({ json: snapshot }));
  await page.route('**/metrics', r => r.fulfill({ json: {} }));
  await page.route('**/projects', r => r.fulfill({ json: { projects: [{ slug: 'den' }] } }));
  await page.route(url => url.pathname === '/meetings' || url.pathname.startsWith('/meetings/'), async r => {
    const pathname = new URL(r.request().url()).pathname;
    const selected = pathname.endsWith(other.id) ? other : m;
    if (pathname.endsWith(other.id)) await new Promise(resolve => setTimeout(resolve, 200));
    if (r.request().method() === 'GET') return r.fulfill({ json: pathname === '/meetings' ? { meetings: records } : { meeting: selected, events: selected.events, takes: [], thread: [] } });
    posts.push({ path: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    return r.fulfill({ status: 202, json: { meeting: m } });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('[data-rail=meetings]').click();
  await page.getByRole('button', { name: 'Open meeting', exact: true }).first().click();
  await page.locator('.meeting-decision').waitFor({ state: 'attached' });
  return { page, posts, errors, close: async () => { await browser.close(); await server.close(); } };
}

test('group discussion has attributed sources, real confidence and linked response controls; decisions create no tickets', { timeout: 90000 }, async () => {
  const t = await open();
  try {
    const sheet = t.page.locator('.den-meeting-sheet');
    await sheet.getByText('Explanation, sources & tools').click();
    assert.match(await sheet.innerText(), /Confidence: unsure/);
    assert.match(await sheet.innerText(), /actual cost unavailable/);
    assert.equal(await t.page.evaluate(() => window.__hit ?? 0), 0);
    assert.match(await sheet.locator('.meeting-face').first().getAttribute('src'), /architect-crane|orchestrator-jiao/);
    await sheet.getByRole('button', { name: 'Ask someone to respond ↗' }).click();
    await sheet.getByLabel('Who should respond').selectOption('qa');
    await sheet.getByLabel('Jump in or redirect').fill('Address this recovery claim');
    await sheet.getByRole('button', { name: 'Send ↑' }).click();
    assert.deepEqual(t.posts[0], { path: `/meetings/${id}/ask`, body: { text: 'Address this recovery claim', sourceId: source, reask: 'qa' } });
    await sheet.getByRole('button', { name: 'Choose A', exact: true }).click();
    assert.deepEqual(t.posts[1], { path: `/meetings/${id}/decide`, body: { option: 'A', questionId: 'q-one' } });
    assert.equal(t.posts.some(p => /publish|tasks|deliveries/.test(p.path)), false);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('switching records resets drafts and confirmations before an asynchronous private read completes', { timeout: 90000 }, async () => {
  const t = await open(1440, 'light', true);
  try {
    await t.page.getByLabel('Jump in or redirect').fill('Unsent first-meeting draft');
    await t.page.getByLabel('Write my answer').fill('Unsent first-meeting answer');
    await t.page.getByRole('button', { name: 'End meeting…', exact: true }).click();
    const second = t.page.getByRole('button', { name: 'Open meeting', exact: true }).nth(1);
    await second.focus(); await t.page.keyboard.press('Enter');
    await t.page.getByText('Opening private meeting record…', { exact: true }).waitFor();
    assert.equal(await t.page.locator('.meeting-end-confirm').count(), 0);
    assert.equal(await t.page.getByRole('button', { name: 'Send ↑' }).count(), 0, 'no controls can target the previous meeting while loading');
    await t.page.getByRole('heading', { name: 'Second private meeting', exact: true }).last().waitFor();
    assert.equal(await t.page.getByLabel('Jump in or redirect').inputValue(), '');
    assert.equal(await t.page.locator('.meeting-end-confirm').count(), 0);
    assert.deepEqual(t.posts, []);
  } finally { await t.close(); }
});

test('composer controls stay above the record footer, and the recent feed links without resuming', { timeout: 120000 }, async () => {
  for (const width of [1600, 375]) {
    const t = await open(width);
    try {
      const bounds = await t.page.locator('.meeting-workspace').evaluate(el => ({ send: el.querySelector('.meeting-composer button').getBoundingClientRect().bottom, textarea: el.querySelector('.meeting-composer textarea').getBoundingClientRect().bottom, footer: el.querySelector('.meeting-footer').getBoundingClientRect().top }));
      assert.ok(bounds.send <= bounds.footer, JSON.stringify(bounds));
      assert.ok(bounds.textarea <= bounds.footer, JSON.stringify(bounds));
      await t.page.getByRole('button', { name: 'Close panel (the meeting keeps running)' }).click();
      const recent = t.page.getByRole('button', { name: 'Recent activity +', exact: true });
      await recent.click();
      await t.page.getByRole('complementary', { name: 'Recent activity' }).getByRole('button', { name: /architect contributed/ }).click();
      await t.page.locator('.meeting-workspace').waitFor();
      assert.deepEqual(t.posts, []);
      assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(t.errors, []);
    } finally { await t.close(); }
  }
});

test('setup has owner default, editable Bao/Jiao, depth, portraits and budget before any start', { timeout: 90000 }, async () => {
  const t = await open();
  try {
    await t.page.getByRole('button', { name: 'Close panel (the meeting keeps running)' }).click();
    await t.page.getByRole('button', { name: 'New meeting ↗' }).click();
    const setup = t.page.getByRole('region', { name: 'Start a meeting' });
    await setup.getByLabel('What would you like to think through?').fill('Review storage');
    await setup.getByLabel('Moderator').selectOption('jiao');
    await setup.getByLabel('Depth').selectOption('dig-in');
    await setup.getByRole('checkbox', { name: /^architect/ }).check();
    await setup.getByLabel('Approved budget ($)').fill('3');
    assert.match(await setup.innerText(), /Estimated.*opening takes and one moderation pass/);
    await setup.getByRole('button', { name: 'Approve setup & start meeting ↗' }).click();
    assert.equal(t.posts[0].path, '/meetings');
    assert.equal(t.posts[0].body.moderator, 'jiao');
    assert.equal(t.posts[0].body.depth, 'dig-in');
    assert.equal(t.posts[0].body.budget, 3);
    assert.deepEqual(t.posts[0].body.roles, ['architect']);
  } finally { await t.close(); }
});

test('narrow workspace tabs expose decisions without page overflow, and close/reopen never sends a resume', { timeout: 90000 }, async () => {
  const t = await open(390);
  try {
    await t.page.getByRole('button', { name: 'Questions & decisions', exact: true }).click();
    await t.page.locator('.meeting-decision').waitFor();
    assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await t.page.getByRole('button', { name: 'Close panel (the meeting keeps running)' }).click();
    await t.page.getByRole('button', { name: 'Open meeting', exact: true }).click();
    assert.deepEqual(t.posts, []);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('both themes share rim glass on existing panels, rail and every button with visible keyboard focus', { timeout: 120000 }, async () => {
  for (const theme of ['light', 'dark']) {
    const t = await open(1440, theme);
    try {
      const missing = await t.page.locator('.forest-shell button').evaluateAll(buttons => buttons.filter(button => !getComputedStyle(button, '::before').backgroundImage.includes('conic-gradient')).map(button => button.className));
      assert.deepEqual(missing, []);
      assert.match(await t.page.locator('.den-meeting-sheet').evaluate(el => getComputedStyle(el, '::before').maskComposite), /exclude/);
      await t.page.getByRole('button', { name: 'Close panel (the meeting keeps running)' }).focus();
      assert.equal(await t.page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
      assert.deepEqual(t.errors, []);
    } finally { await t.close(); }
  }
});
