import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

let server, browser;
before(async () => {
  server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  browser = await chromium.launch(buildLaunchOptions());
}, { timeout: 120000 });
after(async () => { await browser?.close(); await server?.close(); });

const RUN = 'c-af592f417c598394', MEETING = 'm-00000000000000a1';
const TOPICS = ['needs', 'queue', 'work', 'meetings', 'team', 'library', 'tally', 'build'];
async function open({ width = 1440, inventory = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  await lightenScene(context, { skipDraws: !process.env.DEN_SHELL_EVIDENCE_DIR });
  await context.addInitScript(() => {
    sessionStorage.setItem('den.session-token', 'tok-test-123');
    // Keep browser capture deterministic while exercising the real explorer and its listeners.
    let locked = null;
    Object.defineProperty(document, 'pointerLockElement', { get: () => locked });
    HTMLCanvasElement.prototype.requestPointerLock = function () { locked = this; document.dispatchEvent(new Event('pointerlockchange')); };
    document.exitPointerLock = () => { locked = null; document.dispatchEvent(new Event('pointerlockchange')); };
    const listeners = new Map(), add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const key = (options) => typeof options === 'boolean' ? options : !!options?.capture;
    EventTarget.prototype.addEventListener = function (type, fn, options) {
      if (type === 'keydown' && (this === window || this === document)) {
        const list = listeners.get(this) ?? [];
        if (!list.some(x => x.fn === fn && x.capture === key(options))) list.push({ fn, capture: key(options) });
        listeners.set(this, list);
      }
      return add.call(this, type, fn, options);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, options) {
      if (type === 'keydown') listeners.set(this, (listeners.get(this) ?? []).filter(x => x.fn !== fn || x.capture !== key(options)));
      return remove.call(this, type, fn, options);
    };
    window.keyListeners = () => [...listeners.values()].reduce((n, xs) => n + xs.length, 0);
  });
  const page = await context.newPage(), posts = [], errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  const meeting = { id: MEETING, ref: 'den/09-meeting', title: 'Meeting: shell review', state: 'running', chair: 'orchestrator', seats: [{ role: 'product', status: 'waiting', takes: 0 }], round: 'takes', brief: null, decisions: [], live: null, thread: 0, runs: 0 };
  const snapshot = { schema: 1, seq: 1, frontier: [], tickets: [], usage: null, requests: [], meetings: [meeting], deliveries: [], approvals: [], agents: [{ id: RUN, role: 'scout', runtime: 'claude', state: 'working', capabilities: { send: true, stop: true } }] };
  if (inventory) {
    const ticket = (ref, title, extra = {}) => ({ ref, feature: 'den', title, type: 'feature', status: 'ready-for-agent', ready: true, priority: 'P2', effectivePriority: 'P2', blockedBy: [], holder: null, gate: null, ...extra });
    snapshot.tickets = [ticket('den/01-ready', '01: Ready work'), ticket('den/02-active', '02: Active work', { status: 'claimed', ready: false }), ticket('den/04-gate', '04: Merge gate', { status: 'in-review', gate: 'merge', ready: false })];
    snapshot.frontier = ['den/01-ready'];
    snapshot.agents[0].ref = 'den/02-active';
    snapshot.agents[0].capabilities.approve = true;
    snapshot.capacity = { max: 2, cap: 8, load: 1, live: 1, room: 1, refs: ['den/02-active'] };
    snapshot.deliveries = [{ id: 'd-0123456789abcdef', ref: 'den/03-delivery', title: '03: Delivery review', state: 'paused', step: 'ci', pause: { kind: 'ci-red', reason: 'Review the failed check', next: 'Resume after fixing it.' }, live: null, evidence: {}, runs: [] }];
    snapshot.requests = [{ id: 'stop-1', kind: 'router-stop', state: 'pending', ref: 'den/04-gate', note: 'Review router stop' }];
    snapshot.approvals = [{ id: 'a-8313dee2f728c5f1', agentId: RUN, tool: 'Read', summary: 'Inspect the source', state: 'pending', ts: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() }];
  }
  await page.route('**/events', r => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` }));
  await page.route('**/state', r => r.fulfill({ json: snapshot }));
  await page.route('**/metrics', r => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.route('**/library', r => r.fulfill({ json: { entries: [] } }));
  await page.route('**/conversations/**', r => r.fulfill({ json: { entries: [], more: false } }));
  await page.route(url => url.pathname.startsWith('/meetings/'), async r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: { meeting, takes: [], thread: [] } });
    const action = new URL(r.request().url()).pathname.split('/').at(-1);
    posts.push(action);
    if (action === 'stop') { meeting.state = 'paused'; meeting.pause = { kind: 'user', reason: 'Paused by you' }; }
    if (action === 'resume') meeting.state = 'running';
    if (action === 'close') meeting.state = 'closed';
    snapshot.seq++;
    await r.fulfill({ status: 202, json: { meeting } });
    // Deliver the same state change the live bridge publishes.
    await page.evaluate(s => window.dispatchEvent(new CustomEvent('shell-snapshot', { detail: s })), snapshot);
  });
  // The SSE seam also lets the meeting test publish authoritative bridge updates.
  await page.addInitScript(s => {
    window.EventSource = class {
      constructor() { this.listeners = {}; setTimeout(() => { this.onopen?.(); this.emit(s); }, 0); this.update = e => this.emit(e.detail); window.addEventListener('shell-snapshot', this.update); }
      emit(value) { for (const fn of this.listeners.snapshot ?? []) fn({ data: JSON.stringify(value) }); }
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
      close() { window.removeEventListener('shell-snapshot', this.update); }
    };
  }, snapshot);
  await page.goto(server.resolvedUrls.local[0], { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('.den-entry button')?.getAttribute('aria-disabled') !== 'true', null, { timeout: 60000 });
  await page.waitForFunction(async () => {
    const url = performance.getEntriesByType('resource').find(e => e.name.includes('@react-three_fiber'))?.name;
    if (!url) return false;
    const { _roots } = await import(url), state = _roots.get(document.querySelector('canvas'))?.store.getState();
    const world = state?.scene.getObjectByName('Dim Sum Dev · plush bamboo garden');
    let scout;
    world?.traverse(p => { if (p.userData.actorKey === 'scout') scout = p; });
    if (!scout || !world.__r3f?.handlers.onClick) return false;
    window.shellScene = { state, world, scout }; return true;
  }, null, { timeout: 60000 });
  return { page, posts, errors, close: () => context.close() };
}
const camera = page => page.evaluate(() => { const c = window.shellScene.state.get().camera; return [...c.position.toArray(), ...c.quaternion.toArray(), ...c.projectionMatrix.elements].map(n => +n.toFixed(5)); });
const pick = async page => {
  await page.evaluate(() => { const { world, scout } = window.shellScene; world.__r3f.handlers.onClick({ object: scout, stopPropagation() {} }); });
  await page.getByRole('region', { name: 'Selected panda' }).waitFor();
};
const rail = (page, id) => page.locator(`[data-rail="${id}"]`);
const side = page => page.locator('[data-sheet=side]');
async function captureEvidence(page) {
  const dir = process.env.DEN_SHELL_EVIDENCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.getByRole('button', { name: 'Back to the diorama · Esc', exact: true }).click();
  await rail(page, 'team').click();
  await rail(page, 'bao').click();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: `${dir}/den-shell-${colorScheme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/den-shell-390.png` });
}

test('conversation close preserves Panda camera, selection and walk mode; each opener gets focus back', { timeout: 120000 }, async () => {
  const t = await open(); const { page } = t;
  try {
    await page.getByRole('button', { name: '3 · Panda', exact: true }).click();
    await pick(page);
    const opener = page.locator('.proximity-card [data-key=R]');
    for (const close of ['button', 'Escape']) {
      const before = await camera(page);
      await opener.click(); await side(page).waitFor();
      assert.equal(await side(page).getAttribute('aria-modal'), 'false');
      assert.equal(await side(page).locator('h2').evaluate(el => el === document.activeElement), true);
      if (close === 'button') await page.getByRole('button', { name: 'Close conversation', exact: true }).click();
      else await page.keyboard.press('Escape');
      assert.deepEqual(await camera(page), before);
      assert.equal(await page.locator('.den-picked').count(), 1);
      assert.equal(await opener.evaluate(el => el === document.activeElement), true);
      assert.equal(await page.getByRole('button', { name: '3 · Panda', exact: true }).getAttribute('aria-current'), 'true');
    }
    for (const opener of [rail(page, 'bao'), page.locator('.den-bar-talk')]) {
      await opener.click(); await side(page).waitFor(); await page.keyboard.press('Escape');
      assert.equal(await opener.evaluate(el => el === document.activeElement), true);
    }
    await rail(page, 'team').click();
    await page.getByRole('button', { name: /^The Scout, scout, Claude/ }).click();
    const talk = page.getByRole('button', { name: 'Talk to Scout', exact: true });
    await talk.click(); await side(page).waitFor(); await page.keyboard.press('Escape');
    assert.equal(await talk.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Enter the den', exact: true }).click();
    await page.getByRole('status', { name: 'Current location' }).getByText('Entrance', { exact: true }).waitFor();
    const before = await camera(page);
    await rail(page, 'bao').click(); await side(page).waitFor(); await page.keyboard.press('Escape');
    assert.deepEqual(await camera(page), before);
    assert.equal(await page.locator('.den-visiting').count(), 1);
    assert.deepEqual(t.errors, []);
    await captureEvidence(page);
  } finally { await t.close(); }
});

test('Escape takes one layer: confirm, latest sheet, other sheet, selection, cursor, walk', { timeout: 120000 }, async () => {
  const t = await open(); const { page } = t;
  try {
    await pick(page);
    await rail(page, 'meetings').click();
    await page.locator('[data-meeting=running]').getByRole('button', { name: 'Open', exact: true }).click();
    await side(page).getByRole('button', { name: /^End the meeting/ }).click();
    await page.keyboard.press('Escape'); assert.equal(await page.locator('[data-confirm]').count(), 0); assert.equal(await side(page).count(), 1);
    await page.keyboard.press('Escape'); assert.equal(await side(page).count(), 0); assert.equal(await page.locator('[data-sheet=topic]').count(), 1);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('[data-sheet]').count(), 0); assert.equal(await page.locator('.den-picked').count(), 1);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.den-picked').count(), 0);
    const before = await camera(page); await page.keyboard.press('Escape'); assert.deepEqual(await camera(page), before);
    await page.getByRole('button', { name: 'Enter the den', exact: true }).click();
    await page.waitForFunction(() => document.pointerLockElement != null);
    await page.keyboard.press('Escape');
    await page.locator('.den-visiting.den-cursor-free').waitFor();
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.den-visiting').count(), 0);
    await rail(page, 'bao').click(); await rail(page, 'library').click();
    await page.keyboard.press('Escape'); assert.equal(await side(page).count(), 1); assert.equal(await page.locator('[data-sheet=topic]').count(), 0);
    await page.keyboard.press('Escape'); assert.equal(await side(page).count(), 0);
    await pick(page);
    await page.locator('.proximity-card [data-key=R]').click();
    await side(page).getByRole('button', { name: 'Stop agent', exact: true }).click();
    await rail(page, 'library').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-confirm]').count(), 0);
    assert.equal(await page.locator('[data-sheet=topic]').count(), 1);
    assert.equal(await side(page).count(), 1);
  } finally { await t.close(); }
});

test('a topic sheet frees the walking cursor; closing it preserves the walk and camera', { timeout: 120000 }, async () => {
  const t = await open(); const { page } = t;
  try {
    await page.getByRole('button', { name: 'Enter the den', exact: true }).click();
    const before = await camera(page);
    await rail(page, 'work').click();
    assert.equal(await page.evaluate(() => document.pointerLockElement === null), true);
    assert.equal(await page.locator('.den-visiting').count(), 1);
    await page.keyboard.press('Escape'); assert.deepEqual(await camera(page), before);
    assert.equal(await page.locator('.den-visiting').count(), 1);
  } finally { await t.close(); }
});

test('meeting hide and Leave send no end; Pause, Resume and confirmed End send their own actions', { timeout: 120000 }, async () => {
  const t = await open(); const { page } = t;
  try {
    await rail(page, 'meetings').click();
    const row = page.locator('[data-meeting]');
    await row.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('button', { name: 'Close panel (the meeting keeps running)', exact: true }).click();
    assert.deepEqual(t.posts, []); assert.equal(await rail(page, 'meetings').locator('.den-rail-dot').count(), 1);
    await row.getByRole('button', { name: 'Open', exact: true }).click();
    await side(page).getByRole('button', { name: 'Leave meeting', exact: true }).click();
    assert.deepEqual(t.posts, []); await row.getByRole('button', { name: 'Rejoin', exact: true }).waitFor();
    await row.getByRole('button', { name: /^Pause the meeting/ }).click();
    await row.getByRole('button', { name: 'Resume', exact: true }).click();
    await row.getByRole('button', { name: 'Rejoin', exact: true }).click();
    await side(page).getByRole('button', { name: /^End the meeting/ }).click();
    assert.deepEqual(t.posts, ['stop', 'resume']);
    await side(page).getByRole('button', { name: 'End meeting', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-confirm]'));
    assert.deepEqual(t.posts, ['stop', 'resume', 'stop', 'close']);
  } finally { await t.close(); }
});

test('all former destinations survive, every charter role is listed, and 20 cycles leave stable listeners and slots', { timeout: 180000 }, async () => {
  const t = await open({ inventory: true }); const { page } = t;
  try {
    assert.deepEqual(await page.locator('[data-rail]').evaluateAll(els => els.map(el => el.dataset.rail)), ['bao', 'needs', 'queue', 'work', 'meetings', 'team', 'library', 'tally', 'build', 'demo', 'reset']);
    const baseline = await page.evaluate(() => window.keyListeners());
    for (let cycle = 0; cycle < 20; cycle++) for (const id of [...TOPICS, 'bao']) {
      await rail(page, id).click();
      const sheet = page.locator(`[data-sheet=${id === 'bao' ? 'side' : 'topic'}]`);
      await sheet.waitFor();
      assert.equal(await sheet.count(), 1);
      assert.equal(await sheet.locator('.den-sheet-body, .transcript-log').first().evaluate(el => el.scrollTop), 0, `${id} reopens at its start`);
      if (cycle === 0 && id === 'needs') {
        const text = await sheet.innerText();
        for (const part of ['Open thread', 'Allow', '03-delivery', '04-gate', 'router stop']) assert.ok(text.includes(part), `Needs retains ${part}`);
      }
      if (cycle === 0 && id === 'queue') {
        const ready = sheet.locator('.queue-ticket-row').filter({ has: page.getByText('Ready work', { exact: true }) });
        assert.equal(await ready.count(), 1);
        assert.equal(await ready.locator('.queue-ticket-ref').innerText(), '01');
      }
      if (cycle === 0 && id === 'work') {
        assert.ok(await sheet.locator('[data-team-pill=steamers]').count());
        assert.match(await sheet.locator('.slots').innerText(), /02-active/);
        assert.match(await sheet.locator('.deliveries').innerText(), /03: Delivery review/);
        assert.equal(await sheet.getByRole('button', { name: 'Run den/01-ready', exact: true }).count(), 1);
        assert.equal(await sheet.getByRole('button', { name: 'Deliver den/01-ready', exact: true }).count(), 1);
      }
      if (id === 'team' && cycle === 0) {
        const roles = await page.locator('.forest-portrait-list .forest-portrait [data-role], .forest-portrait-list [data-role]').evaluateAll(els => [...new Set(els.map(el => el.dataset.role))]);
        for (const role of ['orchestrator', 'product', 'architect', 'designer', 'developer', 'code-reviewer', 'qa', 'security', 'release-manager', 'sre', 'technical-writer', 'runner', 'herald', 'scout']) assert.ok(roles.includes(role), role);
      }
      await sheet.locator('.den-sheet-body, .transcript-log').first().evaluate(el => { el.scrollTop = 100; });
      await rail(page, id).click(); assert.equal(await page.locator('[data-sheet]').count(), 0);
      assert.equal(await rail(page, id).evaluate(el => el === document.activeElement), true);
    }
    assert.equal(await page.evaluate(() => window.keyListeners()), baseline);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('opening or closing the other sheet preserves topic scroll, profile and conversation draft', { timeout: 120000 }, async () => {
  const t = await open(); const { page } = t;
  try {
    await rail(page, 'team').click();
    await page.getByRole('button', { name: /^The Scout, scout, Claude/ }).click();
    const body = page.locator('#sheet-topic .den-sheet-body');
    await body.evaluate(el => { el.scrollTop = 150; });
    const scroll = await body.evaluate(el => el.scrollTop);
    assert.ok(scroll > 0);
    await rail(page, 'bao').click();
    assert.equal(await body.evaluate(el => el.scrollTop), scroll);
    assert.match(await page.locator('.forest-profile').innerText(), /The Scout/);
    const draft = side(page).locator('.thread-box');
    await draft.fill('Keep this draft while I check the board.');
    await rail(page, 'team').click();
    assert.equal(await draft.inputValue(), 'Keep this draft while I check the board.');
    await rail(page, 'work').click();
    await page.keyboard.press('Escape');
    assert.equal(await draft.inputValue(), 'Keep this draft while I check the board.');
    await pick(page);
    await rail(page, 'meetings').click();
    await page.locator('[data-meeting=running]').getByRole('button', { name: 'Open', exact: true }).click();
    await page.locator('.proximity-card [data-key=R]:enabled').waitFor({ state: 'attached' });
    await page.keyboard.press('KeyR');
    await page.getByRole('dialog', { name: /Conversation with/ }).waitFor();
    assert.equal(await side(page).count(), 1, 'keyboard conversation replaces the meeting in the one side slot');
    assert.equal(await side(page).locator('h2').evaluate(el => el === document.activeElement), true);
  } finally { await t.close(); }
});

test('390px shell has no horizontal scroll and every rail destination can be reached', { timeout: 120000 }, async () => {
  const t = await open({ width: 390 }); const { page } = t;
  try {
    for (const id of [...TOPICS, 'bao']) {
      await rail(page, id).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, id);
      const bounds = await page.locator('[data-sheet]').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, id);
      await page.keyboard.press('Escape');
    }
    await rail(page, 'demo').click(); await page.getByRole('button', { name: 'Stop the demo' }).waitFor(); await rail(page, 'demo').click();
    await rail(page, 'reset').click(); await page.getByText('Back to the whole den', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show labels', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await t.close(); }
});
