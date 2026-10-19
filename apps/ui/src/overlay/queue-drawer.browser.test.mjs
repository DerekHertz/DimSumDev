// den-mvp/62 (spec .scratch/den-mvp/handoffs/62-designer-spec.md), in a real page: the Queue button opens the drawer over the
// scene; it shows Needs you, then the goals with counts; the first goal with a ready ticket is open; a ticket row expands to
// the den's own Run control and a Details button that opens the ticket card; Esc closes it and focus returns to the button.
// The bridge is stubbed at the network. DEN_SHOTS=<dir> saves screenshots (wide and 375px) for the user's visual check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const ticket = (ref, over = {}) => ({
  ref, feature: 'den-mvp', title: `${ref.split('/')[1].split('-')[0]}: ${over.name ?? 'A ticket'}`, type: 'feature', status: 'ready-for-agent', ready: true,
  priority: 'P1', effectivePriority: 'P1', bumps: 0, bumped: false, readySince: null, blockedBy: [], blockedReason: null, holder: null, lastRole: null,
  gate: null, request: null, handoff: null, goal: 'routing', ...over,
});
const snapshot = {
  schema: 1, seq: 1, usage: null, requests: [], sessions: [], agents: [], approvals: [], transcripts: {}, deliveries: [],
  frontier: ['den-mvp/57-routing-rewrite-architecture'],
  goals: [
    { key: 'routing', name: 'Den on the routing project', why: 'The den works inside another repo.', doneWhen: '54 delivered.' },
    { key: 'den', name: 'Running everything from the den', why: 'No terminal.', doneWhen: 'All work lands from the den.' },
  ],
  goalErrors: [],
  tickets: [
    ticket('den-mvp/57-routing-rewrite-architecture', { name: 'Routing rewrite architecture', type: 'design' }),
    ticket('den-mvp/48-o6-slice-1', { name: 'Clean start for other projects', status: 'in-review', ready: false }),
    ticket('den-mvp/52-o6-slice-5', { name: 'Toolchain in the wall', ready: false, blockedBy: [{ ref: 'den-mvp/48-o6-slice-1', status: 'in-review' }] }),
    ticket('den-mvp/62-queue-panel', { name: 'Queue panel', goal: 'den', type: 'ui' }),
  ],
  capacity: { max: 2, cap: 8, load: 0, live: 0, room: 2, refs: [], reserved: { bao: { max: 1, refs: [] }, scout: { max: 1, refs: [] } } },
};

async function open({ width = 1280 } = {}) {
  const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch(buildLaunchOptions());
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width, height: 900 } });
  await lightenScene(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` }));
  await page.route('**/state', (r) => r.fulfill({ json: snapshot }));
  await page.route('**/metrics', (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => document.querySelector('.den-entry button')?.getAttribute('aria-disabled') !== 'true');
  const close = async () => { await browser.close(); await server.close(); };
  return { page, errors, close };
}
const shot = async (page, name) => { if (process.env.DEN_SHOTS) await page.screenshot({ path: path.join(process.env.DEN_SHOTS, name) }); };

test('the queue drawer: goals with counts, a ticket row opens Run and Details, Esc closes it', { timeout: 90000 }, async () => {
  const t = await open();
  try {
    const { page } = t;
    const button = page.locator('.queue-button');
    const drawer = page.locator('#queue-drawer');
    assert.equal(await drawer.getAttribute('data-open'), 'false');
    await button.click();
    assert.equal(await drawer.getAttribute('data-open'), 'true');
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    const text = await drawer.innerText();
    assert.match(text, /4 open/);
    assert.match(text, /Needs you/i);
    const routing = drawer.locator('.queue-goal').first();
    assert.match(await routing.locator('.queue-goal-head').innerText(), /Den on the routing project[\s\S]*3 · 1 ready · 0 you/);
    assert.equal(await routing.getAttribute('data-open'), 'true', 'the first goal with a ready ticket starts open');
    assert.match(await routing.innerText(), /Next:\s*57 Routing rewrite architecture/);
    assert.match(await routing.locator('.queue-waiting').innerText(), /Toolchain in the wall[\s\S]*waiting[\s\S]*waits on 48/);
    await shot(page, 'queue-wide.png');

    await routing.locator('.queue-ready .queue-ticket-row').click();
    await routing.getByRole('button', { name: 'Run den-mvp/57-routing-rewrite-architecture' }).waitFor();
    assert.equal(await routing.locator('.run-select').inputValue(), 'architect', 'a design ticket preselects the architect');
    await routing.getByRole('button', { name: 'Details' }).click();
    assert.equal(await drawer.getAttribute('data-open'), 'false', 'Details closes the drawer');
    const details = page.getByRole('dialog', { name: 'Ticket details' });
    await details.waitFor();
    assert.match(await details.innerText(), /den-mvp\/57-routing-rewrite-architecture/);
    await details.getByRole('button', { name: 'Close ticket details' }).click();
    await button.waitFor({ state: 'visible' });

    await button.click();
    await page.keyboard.press('Escape');
    assert.equal(await drawer.getAttribute('data-open'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('queue-button')), true, 'focus returns to the Queue button');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('the queue drawer at 375px fits the screen', { timeout: 90000 }, async () => {
  const t = await open({ width: 375 });
  try {
    await t.page.locator('.queue-button').click();
    const box = await t.page.locator('#queue-drawer').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 375.5, `the drawer is inside the screen (${box.x} + ${box.width})`);
    assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    await shot(t.page, 'queue-375.png');
  } finally {
    await t.close();
  }
});
