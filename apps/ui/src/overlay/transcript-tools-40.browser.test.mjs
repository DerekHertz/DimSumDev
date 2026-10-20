// Ticket 40: mounted transcript only. No scene/rig/portrait fixtures or installed bridge are used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';
import { source, unsafeText, probes, secret } from '../../../bridge/agents/fixtures/transcript-tools-40.mjs';

const RUN = 'c-0011223344556677', OLD = 'c-8899aabbccddeeff';
const at = '2026-10-19T12:00:00.000Z';
const tool = (runId, id, extra = {}) => ({ id, runId, at, kind: 'tool', name: 'Bash', summary: 'echo actual', status: 'running', invocationId: `invocation-${id}`, source: source(runId, id), ...extra });
const message = (id, text) => ({ id, at, kind: 'message', role: 'agent', text, source: source(RUN, id) });
function fixture() {
  return {
    run: RUN, who: { role: 'architect', name: 'Architect', runtime: 'claude', project: 'den' },
    agents: [{ id: RUN, role: 'architect', runtime: 'claude', project: 'den', state: 'working', capabilities: { send: true, stop: true } }],
    transcripts: { [RUN]: { entries: [message(1, 'Readable agent message.'), tool(RUN, 2), ...Array.from({ length: 35 }, (_, i) => message(i + 3, `Visible history ${i}. ` + 'long readable message '.repeat(5)))], dropped: 0 } },
    pages: [{ entries: [], more: false, before: 0 }],
  };
}
let server, browser;
before(async () => {
  server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  browser = await chromium.launch(buildLaunchOptions());
}, { timeout: 30000 });
after(async () => { await browser?.close(); await server?.close(); });

async function open(t, { data = fixture(), width = 1280, theme = 'light', historyError = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme, reducedMotion: 'reduce' });
  t.after(() => context.close());
  await context.addInitScript(({ data, theme, historyError }) => {
    window.tools40Fixture = data;
    window.tools40Reads = [];
    window.tools40Posts = [];
    window.tools40Keys = new Set();
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, options) => { if (type === 'keydown') window.tools40Keys.add(listener); return add(type, listener, options); };
    document.removeEventListener = (type, listener, options) => { if (type === 'keydown') window.tools40Keys.delete(listener); return remove(type, listener, options); };
    window.tools40HistoryError = historyError;
    document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('data-theme', theme));
    window.tools40Copy = [];
    document.addEventListener('copy', () => window.tools40Copy.push(window.getSelection()?.toString() ?? ''));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => window.tools40Copy.push(text) }, configurable: true });
  }, { data, theme, historyError });
  const page = await context.newPage();
  assert.equal(await page.evaluate(theme => matchMedia(`(prefers-color-scheme: ${theme})`).matches, theme), true, 'native color-scheme media matches the selected theme');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // This fixture page imports the existing panel through Vite, and has no App/network client.
  await page.route('**/__tools40', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module" src="/test-fixtures/transcript-tools-40.jsx"></script></body></html>' }));
  await page.goto(new URL('/__tools40', server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => !!window.tools40);
  await page.getByRole('button', { name: 'Open conversation' }).click();
  await page.getByRole('dialog', { name: 'Conversation with Architect' }).waitFor();
  return { page, errors, thread: page.getByRole('dialog', { name: 'Conversation with Architect' }) };
}
// All history responses in this fixture are resolved Promises. Two paints flush the request's React effects;
// no real network, scene-demanded frame, timer/retry loop or fixed sleep is involved.
const inspect = (page, src) => page.evaluate(async source => {
  window.tools40.open(source);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
}, src);

for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 375], ['dark', 375]]) {
  test(`40 readability: ${theme} at ${width}px keeps the 04 sheet, fixed chrome, wrapping and 15px/1.6 text`, { timeout: 15000 }, async t => {
    const data = fixture();
    data.transcripts[RUN].entries[1] = tool(RUN, 2, { summary: 'long/path/'.repeat(50), input: { command: 'long-command-'.repeat(100) }, result: 'bounded-result-'.repeat(500), status: 'done' });
    const { page, thread, errors } = await open(t, { data, theme, width });
    await thread.locator('.transcript-tool-head').click();
    const metrics = await thread.evaluate(el => {
      const log = el.querySelector('.transcript-log'), body = el.querySelector('.transcript-text'), head = el.querySelector('.transcript-head'), foot = el.querySelector('.thread-foot');
      const style = getComputedStyle(body);
      const before = [head.getBoundingClientRect().y, foot.getBoundingClientRect().y];
      log.scrollTop = 0;
      return { width: el.getBoundingClientRect().width, font: style.fontSize, line: style.lineHeight, overflow: document.documentElement.scrollWidth > innerWidth, scroller: getComputedStyle(log).overflowY, chromeFixed: before.every((v, i) => v === [head, foot][i].getBoundingClientRect().y), motion: getComputedStyle(el).animationName };
    });
    assert.ok(metrics.width <= Math.min(402, width));
    assert.equal(metrics.overflow, false);
    assert.equal(metrics.scroller, 'auto');
    assert.equal(metrics.chromeFixed, true);
    assert.equal(metrics.motion, 'none');
    assert.equal(metrics.font, '15px');
    assert.equal(metrics.line, '24px');
    assert.deepEqual(errors, []);
  });
}

test('40 baseline: tools collapse on reopen, deliberate expansion survives incremental events, and passive updates preserve focus/scroll/unread', { timeout: 15000 }, async t => {
  const { page, thread } = await open(t);
  const toggle = thread.locator('.transcript-tool-head');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  const box = thread.getByRole('textbox', { name: 'Message Architect' });
  await box.focus();
  await thread.locator('.transcript-log').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const before = await thread.locator('.transcript-log').evaluate(el => el.scrollTop);
  await page.evaluate(entry => window.tools40.append(entry), message(100, 'Incremental message'));
  await thread.getByRole('log').getByText('Incremental message', { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await box.evaluate(el => el === document.activeElement), true);
  assert.equal(await thread.locator('.transcript-log').evaluate(el => el.scrollTop), before);
  await thread.getByRole('button', { name: /Jump to latest/ }).waitFor();
  await thread.getByRole('button', { name: 'Close conversation' }).click();
  await page.getByRole('button', { name: 'Open conversation' }).click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
});

test('40 tool details: pending result is explicit and end without success is labelled Ended', { timeout: 15000 }, async t => {
  const { page, thread } = await open(t);
  await thread.locator('.transcript-tool-head').click();
  assert.match(await thread.locator('.transcript-tool-body').innerText(), /Not available yet/);
  await page.evaluate(entry => window.tools40.append(entry), tool(RUN, 2, { status: 'ended' }));
  assert.match(await thread.locator('.transcript-tool-status').innerText(), /Ended/);
});

test('40 source navigation: bounded paged lookup focuses, highlights and expands the exact older run tool with reused id', { timeout: 15000 }, async t => {
  const data = fixture();
  const target = tool(OLD, 2, { summary: 'EXACT-OLDER-TOOL', result: 'older output', status: 'done', input: { command: 'echo older' } });
  data.pages = [{ entries: [{ ...tool('c-aaaaaaaaaaaaaaaa', 2), summary: 'WRONG-REUSED-ROW' }], more: true, before: 40 }, { entries: [target], more: false, before: 0 }];
  const { page, thread } = await open(t, { data });
  await inspect(page, target.source);
  const focused = thread.locator('li').filter({ hasText: 'EXACT-OLDER-TOOL' });
  assert.equal(await focused.count(), 1);
  assert.equal(await focused.evaluate(el => el.contains(document.activeElement)), true);
  assert.equal(await focused.getAttribute('aria-current'), 'location', 'stable nonflashing highlight identifies the exact source');
  assert.equal(await focused.locator('.transcript-tool-head').getAttribute('aria-expanded'), 'true');
  assert.equal(await thread.locator('li').filter({ hasText: 'WRONG-REUSED-ROW' }).locator('.transcript-tool-head').getAttribute('aria-expanded'), 'false');
  const reads = await page.evaluate(() => window.tools40Reads);
  assert.ok(reads.length >= 2 && reads.length <= 4, 'small bounded pages, not an unbounded history fetch');
  for (const r of reads) { assert.ok(r.limit > 0 && r.limit <= 100); assert.equal(r.project, 'den'); assert.equal(r.runtime, 'claude'); }
});

test('40 source unavailable: missing tuple never focuses a nearby reused id', { timeout: 15000 }, async t => {
  const data = fixture();
  data.pages = [{ entries: [tool(OLD, 2, { summary: 'WRONG-SOURCE' })], more: true, before: 40 }];
  const { page, thread } = await open(t, { data });
  await inspect(page, source('c-bbbbbbbbbbbbbbbb', 2, { project: 'missing-project' }));
  assert.match(await thread.innerText(), /Source unavailable/);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('li')?.textContent.includes('WRONG-SOURCE') ?? false), false);
  assert.ok((await page.evaluate(() => window.tools40Reads.length)) <= 4, 'no loop on a repeated cursor');
});

test('40 source unavailable: same-thread missing history with a repeated cursor stops within a bounded page budget', { timeout: 15000 }, async t => {
  const data = fixture();
  data.pages = [{ entries: [tool(OLD, 2, { summary: 'WRONG-SOURCE' })], more: true, before: 40 }];
  const { page, thread } = await open(t, { data });
  await inspect(page, source('c-bbbbbbbbbbbbbbbb', 2));
  assert.match(await thread.innerText(), /Source unavailable/);
  assert.ok((await page.evaluate(() => window.tools40Reads.length)) <= 4, 'the repeated cursor must not drive an unbounded fetch loop');
});

test('40 disclosure: DOM, attributes, tooltip, accessibility and copied text contain only sanitized input/result/preview while source still resolves', { timeout: 15000 }, async t => {
  const data = fixture();
  const entry = tool(RUN, 2, { name: `Bash ${unsafeText()}`, summary: 'p'.repeat(190) + secret, input: { command: `echo visible ${unsafeText()}` }, result: unsafeText() + '\n' + 'r'.repeat(4070) + secret, status: 'done' });
  data.transcripts[RUN].entries[1] = entry;
  const { page, thread } = await open(t, { data });
  await thread.locator('.transcript-tool-head').click();
  const disclosure = await thread.evaluate(el => ({ text: el.innerText, html: el.outerHTML, a11y: [...el.querySelectorAll('[aria-label],[title],[alt]')].map(n => [n.getAttribute('aria-label'), n.title, n.getAttribute('alt')]).flat().join(' ') }));
  const accessible = await thread.ariaSnapshot();
  await thread.locator('.transcript-tool-body').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.press('Control+c');
  const copied = await page.evaluate(() => window.tools40Copy);
  assert.ok(copied.length > 0, 'exercise the actual browser copy event');
  for (const value of [...Object.values(disclosure), accessible, copied.join('')]) for (const probe of [...probes, secret.slice(0, 10)]) assert.equal(value.includes(probe), false, 'no full probe or clipping-boundary fragment in any disclosure surface');
  assert.match(disclosure.text, /masked|redacted/i);
  assert.match(disclosure.text, /visible/);
  assert.equal(disclosure.html.includes(String.fromCharCode(0x202e)), false);
  await inspect(page, entry.source);
  assert.equal(await thread.locator('.transcript-tool').evaluate(el => el.contains(document.activeElement)), true);
  assert.equal(await thread.locator('li[aria-current=location]').count(), 1);
});

test('40 baseline: history errors keep messages and Send/Stop usable; Escape returns opener focus; disposal cleans key listeners', { timeout: 15000 }, async t => {
  const { page, thread, errors } = await open(t, { historyError: true });
  await thread.getByText(/Earlier messages could not be loaded/).waitFor();
  await thread.getByRole('textbox', { name: 'Message Architect' }).fill('Safe follow-up message');
  await thread.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => window.tools40Posts.length === 1);
  await thread.getByRole('button', { name: 'Stop agent' }).click();
  await thread.getByRole('group', { name: 'Stop this agent?' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await thread.isVisible(), true);
  await page.keyboard.press('Escape');
  await thread.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Open conversation' }).evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await page.evaluate(() => window.tools40Posts), [{ role: 'architect', body: { text: 'Safe follow-up message', runId: RUN } }]);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.tools40Unmount());
  assert.equal(await page.evaluate(() => window.tools40Keys.size), 0, 'actual hook disposal removes its subscription');
});
