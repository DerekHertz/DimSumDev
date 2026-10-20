import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { source } from '../../../bridge/agents/fixtures/transcript-tools-40.mjs';

const RUN = 'c-0011223344556677', NEXT = 'c-1122334455667788', OLD = 'c-8899aabbccddeeff';
const message = (runId, id, text) => ({ runId, id, kind: 'message', role: 'agent', at: '2026-10-19T12:00:00Z', text, source: source(runId, id) });
let server, browser;
before(async () => {
  server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  browser = await chromium.launch(buildLaunchOptions());
}, { timeout: 30000 });
after(async () => { await browser?.close(); await server?.close(); });

async function open(t, { closed = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  t.after(() => context.close());
  await context.addInitScript(({ RUN, NEXT }) => {
    window.navigation40Reads = [];
    window.navigation40Fixture = {
      who: { role: 'architect', name: 'Architect', project: 'den', runtime: 'claude' },
      agents: [RUN, NEXT].map(id => ({ id, role: 'architect', project: 'den', runtime: 'claude', state: 'working', capabilities: { send: true, stop: true } })),
      transcripts: {},
    };
  }, { RUN, NEXT });
  const page = await context.newPage();
  await page.route('**/__navigation40', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/src/overlay/fixtures/transcript-navigation-40.jsx"></script>' }));
  await page.goto(new URL('/__navigation40', server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => !!window.navigation40);
  if (!closed) {
    await page.evaluate(run => window.navigation40.open(run), RUN);
    await page.waitForFunction(() => window.navigation40Reads.length === 1);
  }
  return page;
}

test('40 navigation: a closed panel locates and expands a historical tool absent from live agents', { timeout: 15000 }, async t => {
  const page = await open(t, { closed: true });
  const target = { id: 7, runId: OLD, kind: 'tool', name: 'Read', status: 'done', result: 'Historical recorded output', source: source(OLD, 7) };
  await page.evaluate(({ run, source }) => window.navigation40.open(run, source), { run: OLD, source: target.source });
  await page.locator('#sheet-side-title').waitFor();
  await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  assert.deepEqual(await page.evaluate(() => window.navigation40Reads.map(({ role, options }) => ({ role, options }))), [
    { role: 'architect', options: { limit: 100, runtime: 'claude', project: 'den' } },
  ], 'the pinned historical identity must survive the closed-panel opening commit');
  await resolve(page, 0, { entries: [target], more: false, before: 0 });
  const row = page.locator('li[aria-current="location"]');
  await row.waitFor();
  assert.equal(await row.evaluate(el => el === document.activeElement), true);
  assert.equal(await row.getByRole('button').getAttribute('aria-expanded'), 'true');
  assert.match(await row.innerText(), /Historical recorded output/);
  assert.equal(await page.getByText('Source unavailable', { exact: true }).count(), 0);
  await page.evaluate(() => window.navigation40.close());
  await page.evaluate(run => window.navigation40.open(run), OLD);
  await page.waitForFunction(() => window.navigation40Reads.length === 2);
  assert.deepEqual(await page.evaluate(() => window.navigation40Reads[1].options), { limit: 100, runtime: 'claude', project: 'den' }, 'ordinary historical opens use the same complete selectors');
});
async function resolve(page, index, response) {
  await page.evaluate(async ({ index, response }) => {
    window.navigation40Reads[index].resolve(response);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }, { index, response });
}

test('40 navigation: an exact historical message focuses its own stable row without requiring a tool', { timeout: 15000 }, async t => {
  const page = await open(t);
  const target = message(OLD, 7, 'The exact historical message');
  await resolve(page, 0, { entries: [target], more: false, before: 0 });
  await page.evaluate(({ run, source }) => window.navigation40.open(run, source), { run: RUN, source: target.source });
  const row = page.locator('li[aria-current="location"]');
  await row.waitFor();
  assert.match(await row.innerText(), /The exact historical message/);
  assert.equal(await row.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.navigation40Reads.length), 1, 'loaded sources need no extra fetch');
});

test('40 navigation: an obsolete Show earlier response cannot enter a different run conversation', { timeout: 15000 }, async t => {
  const page = await open(t);
  await resolve(page, 0, { entries: [message(OLD, 1, 'Already loaded history')], more: true, before: 40 });
  await page.getByRole('button', { name: 'Show earlier' }).click();
  await page.waitForFunction(() => window.navigation40Reads.length === 2);
  await page.evaluate(run => window.navigation40.open(run), NEXT);
  await page.waitForFunction(() => window.navigation40Reads.length === 3);
  await resolve(page, 2, { entries: [message(NEXT, 1, 'Fresh conversation history')], more: false, before: 0 });
  await resolve(page, 1, { entries: [message(OLD, 2, 'Obsolete history must stay absent')], more: true, before: 30 });
  assert.equal(await page.getByText('Obsolete history must stay absent', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Fresh conversation history', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Show earlier' }).count(), 0);
});

test('40 navigation: an obsolete exact lookup cannot overwrite a newer requested source', { timeout: 15000 }, async t => {
  const page = await open(t);
  await resolve(page, 0, { entries: [], more: true, before: 40 });
  const first = message(OLD, 2, 'Obsolete requested source');
  const second = message(OLD, 3, 'Newest requested source');
  await page.evaluate(({ run, source }) => window.navigation40.open(run, source), { run: RUN, source: first.source });
  await page.waitForFunction(() => window.navigation40Reads.length === 2);
  await page.evaluate(({ run, source }) => window.navigation40.open(run, source), { run: RUN, source: second.source });
  await page.waitForFunction(() => window.navigation40Reads.length === 3);
  await resolve(page, 2, { entries: [second], more: false, before: 0 });
  await resolve(page, 1, { entries: [first], more: false, before: 0 });
  assert.match(await page.locator('li[aria-current="location"]').innerText(), /Newest requested source/);
  assert.equal(await page.getByText('Obsolete requested source', { exact: true }).count(), 0);
});
