// den-mvp outcome 3, in a real page: Deliver on a frontier ticket starts a delivery, the Deliveries list says where each one
// stands and stops a running one, a change with no ticket can be typed, and a delivery that waits is answered from Needs
// you. The bridge is stubbed at the network; what it is sent is what the test checks.
// DEN_SHOTS=<dir> also saves screenshots of the two cards (wide and 375px) for the user's visual check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { lightenScene } from '../../../ci-cd/light-scene.mjs';

const SHA = 'b'.repeat(40);
const ticket = (ref, title, type) => ({ ref, feature: 'fx', title, type, status: 'ready-for-agent', ready: true, priority: 'P2', effectivePriority: 'P2', blockedBy: [], holder: null, gate: null });
const delivery = (more) => ({ id: 'd-0123456789abcdef', ref: 'fx/04-export', title: '04: Export as CSV', state: 'running', step: 'qa', pause: null, base: 'a'.repeat(40), branch: 'den/fx/04-export-01234567', candidate: { sha: SHA }, bounces: 0, live: { runId: 'c-0123456789abcdef', role: 'qa', mode: 'verify' }, evidence: { qa: null, security: null, risk: null, ci: null }, pr: null, runs: [], uncertain: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...more });
const snapshot = {
  schema: 1, seq: 1, frontier: ['fx/08-plain', 'fx/09-question'], usage: null, requests: [], sessions: [], agents: [], approvals: [], transcripts: {},
  capacity: { max: 2, cap: 8, load: 0, live: 0, room: 2, refs: [], reserved: { bao: { max: 1, refs: [] }, scout: { max: 1, refs: [] } } },
  tickets: [ticket('fx/08-plain', '08: Plain feature', 'feature'), ticket('fx/09-question', '09: Which store?', 'design-question')],
  deliveries: [
    delivery({}),
    delivery({ id: 'd-1111111111111111', ref: 'fx/05-panel', title: '05: Slot panel', state: 'paused', step: 'ci', live: null, pause: { kind: 'ci-red', reason: 'a required check failed: test', next: 'Fix the check, or Resume once it passes.' }, evidence: { qa: 'pass', security: null, risk: { clean: true, hits: 0, security: false, userMerge: false }, ci: 'red' }, pr: { number: 7, url: 'https://github.com/o/r/pull/7' } }),
    delivery({ id: 'd-2222222222222222', ref: 'fx/03-old', title: '03: Old fix', state: 'merged', step: null, live: null, evidence: { qa: 'pass', security: null, risk: { clean: true, hits: 0, security: false, userMerge: false }, ci: 'green' }, pr: { number: 5, url: 'https://github.com/o/r/pull/5' } }),
  ],
};

async function open({ width = 1280 } = {}) {
  const server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch(buildLaunchOptions());
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width, height: 900 } });
  await lightenScene(context);
  await context.addInitScript(() => sessionStorage.setItem('den.session-token', 'tok-test-123'));
  const page = await context.newPage();
  const errors = [], posts = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/events', (r) => r.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` }));
  await page.route('**/state', (r) => r.fulfill({ json: snapshot }));
  await page.route('**/metrics', (r) => r.fulfill({ json: { throughput: { windows: [] }, tokensByRole: {}, incidentsByTool: {} } }));
  await page.route('**/deliveries**', (r) => {
    posts.push({ path: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    return r.fulfill({ status: 201, json: { delivery: snapshot.deliveries[0] } });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => document.querySelector('.den-entry button')?.getAttribute('aria-disabled') !== 'true');
  const close = async () => { await browser.close(); await server.close(); };
  return { page, errors, posts, close };
}
const shot = async (page, selector, name) => { if (process.env.DEN_SHOTS) await page.locator(selector).screenshot({ path: path.join(process.env.DEN_SHOTS, name) }); };

test('deliveries in the den: start one on a ticket or from text, see where each stands, stop one, and answer one that waits', { timeout: 90000 }, async () => {
  const t = await open();
  try {
    const { page } = t;
    // The one that waits is in Needs you, with why, what to do next, the facts and the pull request.
    const needs = page.locator('[data-overlay=needs-you]');
    await needs.getByText('05-panel delivery is waiting').waitFor();
    const said = await needs.innerText();
    assert.match(said, /a required check failed: test[\s\S]*qa pass[\s\S]*checks red[\s\S]*Fix the check, or Resume once it passes\.[\s\S]*Open pull request #7/);
    assert.equal(await needs.getByRole('link', { name: 'Open pull request #7' }).getAttribute('href'), 'https://github.com/o/r/pull/7');
    await shot(page, '[data-overlay=needs-you]', 'delivery-needs-you.png');
    await needs.getByRole('button', { name: 'Resume' }).click();
    await page.waitForFunction(() => true);

    const teams = page.locator('[data-overlay=teams]');
    await teams.locator('.card-toggle').click();
    const list = teams.getByRole('region', { name: 'Deliveries' });
    const text = await list.innerText();
    assert.match(text, /1 running[\s\S]*04: Export as CSV[\s\S]*Qa is verifying the commit[\s\S]*05: Slot panel[\s\S]*Waiting: a required check failed: test[\s\S]*03: Old fix[\s\S]*Merged as #5/);
    await list.getByRole('button', { name: 'Stop delivery of fx/04-export' }).click();

    // Deliver is on the software ticket and not on the design question.
    await teams.getByRole('button', { name: 'Deliver fx/08-plain' }).click();
    assert.equal(await teams.getByRole('button', { name: 'Deliver fx/09-question' }).count(), 0);
    await list.getByLabel('Deliver a change with no ticket yet').fill('Add a health route to the dev server.');
    await list.getByRole('button', { name: 'Deliver', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#deliver-new')?.value === '');
    assert.deepEqual(t.posts, [
      { path: '/deliveries/d-1111111111111111/resume', body: {} },
      { path: '/deliveries/d-0123456789abcdef/stop', body: {} },
      { path: '/deliveries', body: { ref: 'fx/08-plain' } },
      { path: '/deliveries', body: { text: 'Add a health route to the dev server.' } },
    ]);
    await shot(page, '[data-overlay=teams]', 'delivery-teams.png');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('deliveries at 375px: the cards do not scroll sideways', { timeout: 90000 }, async () => {
  const t = await open({ width: 375 });
  try {
    const { page } = t;
    await page.locator('[data-overlay=teams] .card-toggle').click();
    await page.getByRole('region', { name: 'Deliveries' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, '[data-overlay=teams]', 'delivery-teams-375.png');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
