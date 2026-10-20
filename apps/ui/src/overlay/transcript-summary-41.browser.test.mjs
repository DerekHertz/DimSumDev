import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { buildLaunchOptions } from '../../../ci-cd/launch-options.mjs';

const RUN = 'run-41', NEXT = 'run-42';
const source = (id, runId = RUN) => ({ project: 'den', runtime: 'claude', role: 'developer', runId, entryId: id });
const message = (id, role, text, runId = RUN) => ({ id, runId, kind: 'message', role, text, at: '2026-10-19T12:00:00Z', source: source(id, runId) });
const fixture = () => ({ run: RUN, who: { role: 'developer', name: 'Engineer', project: 'den', runtime: 'claude' },
  agents: [RUN, NEXT].map(id => ({ id, role: 'developer', project: 'den', runtime: 'claude', resumeOf: 'previous-run', state: 'working', capabilities: { send: true, stop: true } })),
  transcripts: { [RUN]: { entries: [message(1, 'user', 'Make the conversation readable, with source links and no extra model call.'), ...Array.from({ length: 30 }, (_, i) => message(i + 2, 'agent', `Recorded update ${i}. ` + 'Checking focused tests. '.repeat(5)))], dropped: 0 } } });
let server, browser;
before(async () => {
  server = await createServer({ configFile: 'apps/ui/vite.config.mjs', configLoader: 'native', server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  browser = await chromium.launch(buildLaunchOptions());
}, { timeout: 30000 });
after(async () => { await browser?.close(); await server?.close(); });
const flush = page => page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
async function open(t, { data = fixture(), theme = 'light', width = 1280 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme, reducedMotion: 'reduce' });
  t.after(() => context.close());
  await context.addInitScript(data => { window.summary41Fixture = data; window.summary41Calls = []; }, data);
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (['fetch', 'xhr', 'eventsource'].includes(r.resourceType())) requests.push(r.url()); });
  await page.route('**/__summary41', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div><script type="module" src="/test-fixtures/transcript-summary-41.jsx"></script>' }));
  await page.goto(new URL('/__summary41', server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => !!window.summary41);
  await page.evaluate(() => window.summary41.open());
  await page.getByRole('region', { name: 'Summary' }).waitFor();
  await flush(page);
  return { page, requests, errors, summary: page.getByRole('region', { name: 'Summary' }) };
}

test('41 mounted: citations focus exact task/update rows; collapse survives tool bursts and source updates without extra calls', { timeout: 15000 }, async t => {
  const data = fixture();
  const { page, summary, requests, errors } = await open(t, { data });
  await summary.getByRole('button', { name: 'Source for task' }).click();
  assert.match(await page.locator('li[aria-current="location"]').innerText(), /Make the conversation readable/);
  assert.equal(await page.locator('li[aria-current="location"]').evaluate(el => el === document.activeElement), true);
  await summary.getByRole('button', { name: 'Source for latest update' }).click();
  assert.match(await page.locator('li[aria-current="location"]').innerText(), /Recorded update 29/);
  await summary.getByRole('button', { name: 'Collapse summary' }).click();
  assert.match(await summary.innerText(), /Summary\s+From source messages/);
  assert.equal(await summary.getByRole('button', { name: 'Source for task' }).count(), 1);
  assert.equal(await summary.getByRole('button', { name: 'Source for latest update' }).count(), 1);
  assert.doesNotMatch(await summary.innerText(), /Recorded update 29/);
  await page.getByRole('textbox').fill('Keep this draft');
  const before = await page.locator('.transcript-log').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })); return el.scrollTop; });
  await page.evaluate(() => { window.summary41Mutations = 0; new MutationObserver(records => { window.summary41Mutations += records.length; }).observe(document.querySelector('.transcript-summary'), { subtree: true, childList: true, characterData: true, attributes: true }); });
  data.transcripts[RUN].entries.push({ id: 32, kind: 'tool', name: 'Read', status: 'running', source: source(32) });
  await page.evaluate(transcripts => window.summary41.setTranscripts(transcripts), data.transcripts);
  await flush(page);
  assert.equal(await page.evaluate(() => window.summary41Mutations), 0, 'tool traffic makes no summary DOM changes');
  assert.equal(await summary.getByRole('button', { name: 'Expand summary' }).getAttribute('aria-expanded'), 'false');
  data.transcripts[RUN].entries.push(message(33, 'agent', 'Tests passed in the recorded update.'));
  await page.evaluate(transcripts => window.summary41.setTranscripts(transcripts), data.transcripts);
  await flush(page);
  assert.equal(await summary.getByRole('button', { name: 'Expand summary' }).getAttribute('aria-expanded'), 'false');
  assert.equal(await page.getByRole('textbox').inputValue(), 'Keep this draft');
  assert.equal(await page.getByRole('textbox').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('.transcript-log').evaluate(el => el.scrollTop), before);
  await summary.getByRole('button', { name: 'Expand summary' }).click();
  assert.match(await summary.innerText(), /Tests passed in the recorded update/);
  assert.deepEqual(await page.evaluate(() => window.summary41Calls.map(c => c.method)), ['getConversation']);
  assert.deepEqual(requests, [], 'no inference or summarization network traffic');
  assert.deepEqual(errors, []);
});

test('41 mounted: authoritative history populates only selected run; follow-up and loading/error states remain truthful', { timeout: 15000 }, async t => {
  const data = fixture(); data.transcripts = {}; data.historyPending = true;
  const { page, summary } = await open(t, { data });
  assert.match(await summary.innerText(), /Task scope not loaded/);
  assert.match(await summary.innerText(), /No agent update yet/);
  assert.equal(await summary.getByRole('button', { name: /Source for/ }).count(), 0);
  await page.evaluate(entries => window.summary41History.resolve({ entries, more: false, before: 0 }), [message(1, 'user', 'Wrong older task', 'older'), message(1, 'user', 'Selected historical task'), message(2, 'agent', 'Selected history update')]);
  await flush(page);
  assert.match(await summary.innerText(), /Selected historical task/);
  assert.doesNotMatch(await summary.innerText(), /Wrong older task/);
  await summary.getByRole('button', { name: 'Source for task' }).click();
  assert.match(await page.locator('li[aria-current="location"]').innerText(), /Selected historical task/);
  await page.evaluate(run => window.summary41.open(run), NEXT);
  await flush(page);
  assert.match(await summary.innerText(), /Task scope not loaded/);
  await page.evaluate(() => window.summary41History.reject({ reason: 'History unavailable' }));
  await flush(page);
  assert.match(await page.locator('.transcript-log').innerText(), /History unavailable/);
  assert.match(await summary.innerText(), /No agent update yet/);
  assert.equal(await page.getByRole('textbox').isEnabled(), true);
});

test('41 mounted: secret spanning clip boundary is absent from DOM, attributes, copied selection and cited safe row', { timeout: 15000 }, async t => {
  const data = fixture(), token = ['gh', 'p_', 'q'.repeat(36)].join('');
  data.transcripts[RUN].entries = [message(1, 'user', 'x'.repeat(140) + token + ' tail'), message(2, 'agent', token)];
  const { page, summary } = await open(t, { data });
  const html = await summary.evaluate(el => el.outerHTML);
  assert.ok(!html.includes(token) && !html.includes(token.slice(0, 15)));
  assert.match(await summary.innerText(), /masked: possible secret/);
  const copy = await summary.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); });
  assert.ok(!copy.includes(token) && !copy.includes(token.slice(0, 15)));
  await summary.getByRole('button', { name: 'Source for latest update' }).click();
  assert.match(await page.locator('li[aria-current="location"]').innerText(), /masked: possible secret/);
});

for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 375], ['dark', 375]]) {
  test(`41 layout: ${theme} ${width}px preserves shell, four-line excerpts, composer, scrolling and reduced motion`, { timeout: 15000 }, async t => {
    const { page, summary, errors } = await open(t, { theme, width });
    const metrics = await page.locator('#sheet-side').evaluate(el => {
      const log = el.querySelector('.transcript-log'), summary = el.querySelector('.transcript-summary'), head = el.querySelector('.transcript-head'), foot = el.querySelector('.thread-foot');
      const positions = [head, summary, foot].map(n => n.getBoundingClientRect().y);
      log.scrollTop = 0;
      return { width: el.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > innerWidth, scroller: getComputedStyle(log).overflowY, logHeight: log.getBoundingClientRect().height, fixed: [head, summary, foot].every((n, i) => n.getBoundingClientRect().y === positions[i]), excerpts: [...summary.querySelectorAll('.transcript-summary-excerpt')].map(n => ({ height: n.getBoundingClientRect().height, line: parseFloat(getComputedStyle(n).lineHeight) })), motion: getComputedStyle(el).animationName, composer: foot.getBoundingClientRect().bottom <= innerHeight };
    });
    assert.ok(metrics.width <= Math.min(402, width));
    assert.equal(metrics.overflow, false);
    assert.equal(metrics.scroller, 'auto');
    assert.ok(metrics.logHeight >= 200, 'the summary must leave readable history within 04’s full-height sheet');
    assert.equal(metrics.fixed, true);
    assert.ok(metrics.excerpts.every(e => e.height <= e.line * 2 + 1));
    assert.equal(metrics.composer, true);
    assert.equal(metrics.motion, 'none');
    assert.equal(await page.evaluate(theme => matchMedia(`(prefers-color-scheme: ${theme})`).matches, theme), true);
    assert.deepEqual(errors, []);
    if (process.env.SUMMARY_41_PREVIEW_DIR) {
      await mkdir(process.env.SUMMARY_41_PREVIEW_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.SUMMARY_41_PREVIEW_DIR}/41-${theme}-${width}-expanded.png` });
      await summary.getByRole('button', { name: 'Collapse summary' }).click();
      await page.screenshot({ path: `${process.env.SUMMARY_41_PREVIEW_DIR}/41-${theme}-${width}-collapsed.png` });
    }
  });
}
